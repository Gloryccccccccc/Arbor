import asyncio
import codecs
import copy
import json
import re
from collections.abc import AsyncGenerator, AsyncIterator
from typing import Any, Self
from urllib.parse import urlsplit, urlunsplit

import httpx

from .context import dumps
from .errors import ArborError
from .types import Event, Message, ModelRequest


def endpoint_url(base_url: str, resource: str) -> str:
    try:
        url = urlsplit(base_url)
        if url.scheme != "https" and not (
            url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1", "::1"}
        ):
            raise ValueError("scheme")
        if not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError("credentials")
        base = urlunsplit(url).rstrip("/")
    except ValueError:
        raise ArborError(
            "configuration",
            "Use an HTTPS model API URL without credentials or query parameters; HTTP is allowed on loopback.",
        ) from None
    return base if base.endswith("/" + resource) else base + "/" + resource


def usage_counts(value: Any, input_key: str, output_key: str) -> dict[str, int] | None:
    if isinstance(value, dict) and all(
        type(value.get(k)) is int and 0 <= value[k] <= 2**53 - 1 for k in (input_key, output_key)
    ):
        return {"inputTokens": value[input_key], "outputTokens": value[output_key]}
    return None


class HTTPProvider:
    id = "compatible"

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        base_url: str,
        resource: str,
        context_window: int = 64_000,
        timeout: float = 60,
        client: httpx.AsyncClient | None = None,
    ):
        if not api_key.strip():
            raise ArborError("configuration", "Set ARBOR_API_KEY before starting Arbor.")
        if not model.strip():
            raise ArborError("configuration", "Specify the exact model ID from your provider's console.")
        if type(context_window) is not int or context_window <= 0 or timeout <= 0:
            raise ArborError("configuration", "Context window and timeout must be positive.")
        self.model = model
        self.context_window = context_window
        self.endpoint_identity = endpoint_url(base_url, resource)
        self._api_key = api_key.strip()
        self._timeout = timeout
        self._owned_client = client is None
        self._client = client or httpx.AsyncClient(timeout=None)

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owned_client:
            await self._client.aclose()

    async def _events(self, body: dict[str, Any]) -> AsyncGenerator[dict[str, Any] | str]:
        try:
            async with (
                asyncio.timeout(self._timeout),
                self._client.stream(
                    "POST",
                    self.endpoint_identity,
                    headers={"Authorization": "Bearer " + self._api_key},
                    json=body,
                ) as response,
            ):
                if not response.is_success:
                    raise ArborError(
                        "provider_http", f"The model endpoint returned HTTP {response.status_code}."
                    )
                decoder = codecs.getincrementaldecoder("utf-8-sig")()
                pending = ""
                data: list[str] = []
                received = 0
                async for chunk in response.aiter_bytes():
                    received += len(chunk)
                    if received > 8 * 1024 * 1024:
                        raise ArborError("provider_protocol", "The model stream exceeded the response limit.")
                    pending += decoder.decode(chunk)
                    while match := re.search(r"\r\n|\n|\r", pending):
                        if match.group() == "\r" and match.end() == len(pending):
                            break
                        line, pending = pending[: match.start()], pending[match.end() :]
                        if not line:
                            if data:
                                payload = "\n".join(data)
                                data.clear()
                                if payload == "[DONE]":
                                    yield payload
                                else:
                                    try:
                                        value = json.loads(payload)
                                    except ValueError:
                                        raise ArborError(
                                            "provider_protocol", "The stream contained invalid JSON."
                                        ) from None
                                    if not isinstance(value, dict):
                                        raise ArborError(
                                            "provider_protocol", "The stream contained an invalid event."
                                        )
                                    yield value
                        elif not line.startswith(":"):
                            field, _, value = line.partition(":")
                            if field == "data":
                                data.append(value.removeprefix(" "))
                            elif field not in {"event", "id", "retry"}:
                                raise ArborError(
                                    "provider_protocol", "The model returned malformed SSE events."
                                )
                decoder.decode(b"", final=True)
        except (TimeoutError, httpx.TimeoutException):
            raise ArborError("provider_timeout", "The model request or stream timed out.") from None
        except (httpx.HTTPError, OSError):
            raise ArborError("provider_network", "The model stream disconnected before completion.") from None
        except UnicodeError:
            raise ArborError("provider_protocol", "The model returned invalid UTF-8.") from None


class ChatCompletionsProvider(HTTPProvider):
    def __init__(self, *, api_key: str, model: str, base_url: str, **kwargs: Any):
        super().__init__(
            api_key=api_key, model=model, base_url=base_url, resource="chat/completions", **kwargs
        )

    def request_parameters(self) -> dict[str, Any]:
        return {}

    async def stream(self, request: ModelRequest) -> AsyncIterator[Event]:
        messages: list[dict[str, Any]] = [{"role": "system", "content": request.system}]
        for message in request.messages:
            if message["role"] == "assistant":
                item: dict[str, Any] = {"role": "assistant", "content": message["content"] or None}
                if "reasoningContent" in message:
                    item["reasoning_content"] = message["reasoningContent"]
                if message["toolCalls"]:
                    item["tool_calls"] = [
                        {
                            "id": c["id"],
                            "type": "function",
                            "function": {"name": c["name"], "arguments": dumps(c["arguments"])},
                        }
                        for c in message["toolCalls"]
                    ]
                messages.append(item)
            elif message["role"] == "tool":
                messages.append(
                    {"role": "tool", "tool_call_id": message["toolCallId"], "content": message["content"]}
                )
            else:
                messages.append({"role": "user", "content": message["content"]})
        body: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "stream": True,
            "stream_options": {"include_usage": True},
            "max_tokens": request.max_output_tokens,
            **self.request_parameters(),
        }
        if request.tools:
            body["tools"] = [{"type": "function", "function": t} for t in request.tools]
        calls: dict[int, dict[str, str]] = {}
        content = ""
        reasoning: str | None = None
        finish = None
        usage = None
        done = False
        iterator = self._events(body)
        try:
            async for payload in iterator:
                if payload == "[DONE]":
                    done = True
                    break
                if not isinstance(payload, dict) or payload.get("error"):
                    raise ArborError("provider_protocol", "The model stream reported an error.")
                usage = usage_counts(payload.get("usage"), "prompt_tokens", "completion_tokens") or usage
                choices = payload.get("choices")
                if not isinstance(choices, list):
                    raise ArborError("provider_protocol", "The stream omitted its choices array.")
                if not choices:
                    continue
                choice = choices[0]
                finish = choice.get("finish_reason") or finish
                delta = choice.get("delta") or {}
                if isinstance(delta.get("reasoning_content"), str):
                    reasoning = (reasoning or "") + delta["reasoning_content"]
                if isinstance(delta.get("content"), str):
                    content += delta["content"]
                    yield {"type": "text_delta", "text": delta["content"]}
                for part in delta.get("tool_calls", []):
                    index = part.get("index")
                    if type(index) is not int or not 0 <= index < 32:
                        raise ArborError("provider_protocol", "Invalid tool call index.")
                    call = calls.setdefault(index, {"id": "", "name": "", "arguments": ""})
                    call["id"] += part.get("id") or ""
                    function = part.get("function") or {}
                    call["name"] += function.get("name") or ""
                    if function.get("arguments"):
                        call["arguments"] += function["arguments"]
                        yield {"type": "tool_delta", "index": index, "argumentsDelta": function["arguments"]}
                    if len(call["arguments"]) > 1_000_000:
                        raise ArborError("provider_protocol", "Tool arguments exceeded their size limit.")
        finally:
            await iterator.aclose()
        if not done or finish not in {"stop", "tool_calls"}:
            raise ArborError(
                "provider_incomplete",
                "The response was interrupted or exceeded its output limit; this turn's tools were not executed.",
            )
        if bool(calls) != (finish == "tool_calls"):
            raise ArborError("provider_protocol", "Finish reason and tool calls disagree.")
        decoded = []
        ids = set()
        for _, call in sorted(calls.items()):
            if not call["id"] or not call["name"] or call["id"] in ids:
                raise ArborError("provider_protocol", "Missing or duplicate tool call identity.")
            ids.add(call["id"])
            try:
                args = json.loads(call["arguments"])
            except ValueError:
                raise ArborError(
                    "provider_protocol", "Incomplete tool arguments; no tools were executed."
                ) from None
            decoded.append({"id": call["id"], "name": call["name"], "arguments": args})
        message = {"role": "assistant", "content": content, "toolCalls": decoded}
        if reasoning is not None:
            message["reasoningContent"] = reasoning
        yield {"type": "response", "message": message, "usage": usage}


class DeepSeekProvider(ChatCompletionsProvider):
    id = "deepseek"

    def __init__(
        self,
        *,
        api_key: str,
        model: str = "deepseek-flash",
        base_url: str = "https://api.deepseek.com",
        **kwargs: Any,
    ):
        if not api_key.strip():
            raise ArborError("configuration", "Set DEEPSEEK_API_KEY before starting Arbor.")
        super().__init__(api_key=api_key, model=model, base_url=base_url, **kwargs)

    def request_parameters(self) -> dict[str, Any]:
        return {"thinking": {"type": "disabled"}}


class BailianProvider(ChatCompletionsProvider):
    id = "bailian"

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1",
        enable_thinking: bool | None = None,
        **kwargs: Any,
    ):
        if not api_key.strip():
            raise ArborError("configuration", "Set DASHSCOPE_API_KEY before starting Arbor.")
        self.enable_thinking = enable_thinking
        super().__init__(api_key=api_key, model=model, base_url=base_url, **kwargs)

    def request_parameters(self) -> dict[str, Any]:
        return {} if self.enable_thinking is None else {"enable_thinking": self.enable_thinking}


def decode_output(output: Any) -> Message:
    def fail() -> None:
        raise ArborError(
            "provider_protocol",
            "Invalid or incomplete Responses output; this turn's tools were not executed.",
        )

    if not isinstance(output, list) or len(output) > 128:
        fail()
    content = ""
    calls: list[dict[str, Any]] = []
    ids: set[str] = set()
    for item in output:
        if not isinstance(item, dict) or ("status" in item and item["status"] != "completed"):
            fail()
        if item.get("type") == "message":
            if item.get("role") != "assistant" or not isinstance(item.get("content"), list):
                fail()
            for part in item["content"]:
                field = (
                    "text"
                    if part.get("type") == "output_text"
                    else "refusal"
                    if part.get("type") == "refusal"
                    else ""
                )
                if not field or not isinstance(part.get(field), str):
                    fail()
                content += part[field]
        elif item.get("type") == "function_call":
            if (
                not isinstance(item.get("call_id"), str)
                or not item["call_id"]
                or item["call_id"] in ids
                or not isinstance(item.get("name"), str)
                or not item["name"]
                or not isinstance(item.get("arguments"), str)
                or len(item["arguments"]) > 1_000_000
                or len(calls) >= 32
            ):
                fail()
            try:
                arguments = json.loads(item["arguments"])
            except ValueError:
                fail()
            ids.add(item["call_id"])
            calls.append({"id": item["call_id"], "name": item["name"], "arguments": arguments})
        elif item.get("type") != "reasoning":
            fail()
    return {
        "role": "assistant",
        "content": content,
        "toolCalls": calls,
        "providerState": {"protocol": "responses", "output": copy.deepcopy(output)},
    }


class ResponsesProvider(HTTPProvider):
    id = "responses"

    def __init__(self, *, api_key: str, model: str, base_url: str, **kwargs: Any):
        super().__init__(api_key=api_key, model=model, base_url=base_url, resource="responses", **kwargs)

    async def stream(self, request: ModelRequest) -> AsyncIterator[Event]:
        inputs = []
        for message in request.messages:
            if message["role"] == "user":
                inputs.append({"role": "user", "content": message["content"]})
            elif message["role"] == "tool":
                inputs.append(
                    {
                        "type": "function_call_output",
                        "call_id": message["toolCallId"],
                        "output": message["content"],
                    }
                )
            elif state := message.get("providerState"):
                decoded = decode_output(state.get("output"))
                if state.get("protocol") != "responses" or any(
                    decoded[k] != message[k] for k in ("content", "toolCalls")
                ):
                    raise ArborError(
                        "provider_protocol", "Saved Responses items disagree with the assistant message."
                    )
                inputs.extend(state["output"])
            else:
                if message["content"]:
                    inputs.append({"role": "assistant", "content": message["content"]})
                inputs.extend(
                    {
                        "type": "function_call",
                        "call_id": c["id"],
                        "name": c["name"],
                        "arguments": dumps(c["arguments"]),
                    }
                    for c in message["toolCalls"]
                )
        body: dict[str, Any] = {
            "model": self.model,
            "instructions": request.system,
            "input": inputs,
            "stream": True,
            "store": False,
            "include": ["reasoning.encrypted_content"],
            "max_output_tokens": request.max_output_tokens,
        }
        if request.tools:
            body["tools"] = [{"type": "function", **t, "strict": False} for t in request.tools]
        text = ""
        iterator = self._events(body)
        try:
            async for payload in iterator:
                if payload == "[DONE]":
                    continue
                if not isinstance(payload, dict) or not isinstance(payload.get("type"), str):
                    raise ArborError("provider_protocol", "Invalid Responses stream event.")
                kind = payload["type"]
                if kind in {"error", "response.failed", "response.incomplete"}:
                    raise ArborError(
                        "provider_incomplete", "The Responses stream failed or exceeded its output limit."
                    )
                if kind == "response.output_text.delta":
                    if not isinstance(payload.get("delta"), str):
                        raise ArborError("provider_protocol", "Invalid text delta.")
                    text += payload["delta"]
                    yield {"type": "text_delta", "text": payload["delta"]}
                if kind == "response.function_call_arguments.delta":
                    index = payload.get("output_index")
                    if (
                        type(index) is not int
                        or not 0 <= index < 128
                        or not isinstance(payload.get("delta"), str)
                    ):
                        raise ArborError("provider_protocol", "Invalid function delta.")
                    yield {"type": "tool_delta", "index": index, "argumentsDelta": payload["delta"]}
                if kind == "response.completed":
                    result = payload.get("response")
                    if (
                        not isinstance(result, dict)
                        or result.get("status") != "completed"
                        or result.get("error")
                    ):
                        raise ArborError("provider_protocol", "The Responses result is incomplete.")
                    message = decode_output(result.get("output"))
                    if not message["content"].startswith(text):
                        raise ArborError("provider_protocol", "The completed text disagrees with its stream.")
                    if len(message["content"]) > len(text):
                        yield {"type": "text_delta", "text": message["content"][len(text) :]}
                    yield {
                        "type": "response",
                        "message": message,
                        "usage": usage_counts(result.get("usage"), "input_tokens", "output_tokens"),
                    }
                    return
        finally:
            await iterator.aclose()
        raise ArborError("provider_incomplete", "The Responses stream ended before completion.")
