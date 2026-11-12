import asyncio
import json

import httpx
import pytest

from arbor.errors import ArborError
from arbor.models import BailianProvider, ChatCompletionsProvider, DeepSeekProvider, ResponsesProvider
from arbor.types import ModelRequest

REQUEST = ModelRequest(
    "Rules",
    [{"role": "user", "content": "Read a file"}],
    [{"name": "read", "description": "Read", "parameters": {"type": "object"}}],
    1000,
)
CALL = {
    "type": "function_call",
    "id": "fc-item",
    "status": "completed",
    "call_id": "call-1",
    "name": "read",
    "arguments": '{"path":"a.py"}',
}
REASONING = {"type": "reasoning", "id": "rs", "summary": [], "encrypted_content": "opaque-reasoning"}


def event(value):
    return "data: " + json.dumps(value, ensure_ascii=False) + "\n\n"


def text_item(text):
    return {
        "type": "message",
        "id": "m",
        "status": "completed",
        "role": "assistant",
        "content": [{"type": "output_text", "text": text, "annotations": []}],
    }


def completed(output):
    return event(
        {
            "type": "response.completed",
            "response": {
                "status": "completed",
                "output": output,
                "usage": {"input_tokens": 20, "output_tokens": 8},
            },
        }
    )


class Chunks(httpx.AsyncByteStream):
    def __init__(self, source, size=1):
        self.data, self.size, self.closed = source.encode("utf-8"), size, False

    async def __aiter__(self):
        for index in range(0, len(self.data), self.size):
            yield self.data[index : index + self.size]

    async def aclose(self):
        self.closed = True


async def collect(provider, request=REQUEST):
    return [item async for item in provider.stream(request)]


async def test_responses_fragmented_text_tools_and_request():
    sent = []
    source = event({"type": "response.output_text.delta", "delta": "读取文件"})
    source += event(
        {"type": "response.function_call_arguments.delta", "output_index": 2, "delta": '{"path":'}
    )
    source += completed([REASONING, text_item("读取文件"), CALL])
    chunks = Chunks(source)

    async def handler(request):
        sent.append((str(request.url), json.loads(request.content)))
        return httpx.Response(200, stream=chunks)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        model = ResponsesProvider(
            api_key="secret-test-key",
            model="gpt-6.1-sol",
            base_url="https://example.com/v1/responses/",
            client=client,
        )
        events = await collect(model)
    assert chunks.closed
    assert events[-1]["message"]["toolCalls"] == [
        {"id": "call-1", "name": "read", "arguments": {"path": "a.py"}}
    ]
    assert events[-1]["message"]["providerState"]["output"][0] == REASONING
    assert events[-1]["usage"] == {"inputTokens": 20, "outputTokens": 8}
    assert sent[0][0] == "https://example.com/v1/responses"
    body = sent[0][1]
    assert body["store"] is False and body["stream"] is True
    assert body["tools"][0]["name"] == "read" and body["tools"][0]["strict"] is False
    assert "messages" not in body and "previous_response_id" not in body
    assert "secret-test-key" not in json.dumps(events)


async def test_responses_reasoning_round_trip_and_identity():
    sent = []

    async def handler(request):
        sent.append(json.loads(request.content))
        return httpx.Response(
            200, stream=Chunks(completed([REASONING, CALL] if len(sent) == 1 else [text_item("done")]))
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        provider = ResponsesProvider(
            api_key="key", model="gpt-6.1-sol", base_url="https://example.com/v1", client=client
        )
        response = (await collect(provider))[-1]["message"]
        request = ModelRequest(
            "Rules",
            REQUEST.messages
            + [
                response,
                {
                    "role": "tool",
                    "toolCallId": "call-1",
                    "name": "read",
                    "content": "evidence",
                    "isError": False,
                },
            ],
            REQUEST.tools,
            1000,
        )
        await collect(provider, request)
        assert sent[1]["input"] == [
            *REQUEST.messages,
            REASONING,
            CALL,
            {"type": "function_call_output", "call_id": "call-1", "output": "evidence"},
        ]
        response["toolCalls"][0]["id"] = "different"
        with pytest.raises(ArborError, match="disagree"):
            await collect(provider, request)
        assert len(sent) == 2


@pytest.mark.parametrize(
    "source",
    [
        event({"type": "response.output_item.done", "item": CALL}) + "data: [DONE]\n\n",
        event({"type": "response.incomplete"}),
        event({"type": "response.failed"}),
        event({"type": "error", "message": "secret-test-key"}),
        completed([{**CALL, "arguments": '{"path":'}]),
        completed([CALL, {**CALL, "id": "other-item"}]),
        completed([{**CALL, "status": "in_progress"}]),
        "data: {invalid}\n\n",
        "not-an-sse-field\n\n",
        event({"type": "response.output_text.delta", "delta": "hello"}) + completed([text_item("different")]),
    ],
)
async def test_responses_rejects_partial_or_invalid_events(source):
    chunks = Chunks(source)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(200, stream=chunks))
    ) as client:
        provider = ResponsesProvider(
            api_key="key", model="gpt-6.1-sol", base_url="https://example.com/v1", client=client
        )
        emitted = []
        with pytest.raises(ArborError):
            async for item in provider.stream(REQUEST):
                emitted.append(item)
        assert not any(e["type"] == "response" for e in emitted)
    assert chunks.closed


async def test_chat_fragmented_utf8_arguments_and_usage():
    source = event({"choices": [{"delta": {"content": "读取文件", "reasoning_content": "inspect"}}]})
    source += event(
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call-1",
                                "function": {"name": "read", "arguments": '{"path":'},
                            }
                        ]
                    }
                }
            ]
        }
    )
    source += event(
        {
            "choices": [
                {
                    "delta": {"tool_calls": [{"index": 0, "function": {"arguments": '"a.py"}'}}]},
                    "finish_reason": "tool_calls",
                }
            ]
        }
    )
    source += (
        event({"choices": [], "usage": {"prompt_tokens": 20, "completion_tokens": 8}}) + "data: [DONE]\n\n"
    )
    sent = []

    async def handler(request):
        sent.append(json.loads(request.content))
        return httpx.Response(200, stream=Chunks(source))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        provider = DeepSeekProvider(api_key="key", client=client)
        response = (await collect(provider))[-1]
        assert response["message"]["toolCalls"][0]["arguments"] == {"path": "a.py"}
        assert response["usage"] == {"inputTokens": 20, "outputTokens": 8}
        assert sent[0]["thinking"] == {"type": "disabled"}
        request = ModelRequest(
            "Rules",
            REQUEST.messages
            + [
                response["message"],
                {
                    "role": "tool",
                    "toolCallId": "call-1",
                    "name": "read",
                    "content": "evidence",
                    "isError": False,
                },
            ],
            REQUEST.tools,
            1000,
        )
        await collect(provider, request)
        assert sent[1]["messages"][2]["reasoning_content"] == "inspect"
        assert sent[1]["messages"][2]["tool_calls"][0]["function"]["arguments"] == '{"path":"a.py"}'


@pytest.mark.parametrize(
    "source",
    [
        event({"choices": [{"delta": {}, "finish_reason": "stop"}]}),
        event({"choices": [{"delta": {}, "finish_reason": "length"}]}) + "data: [DONE]\n\n",
        event(
            {
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [
                                {"index": 0, "id": "x", "function": {"name": "read", "arguments": "{"}}
                            ]
                        },
                        "finish_reason": "tool_calls",
                    }
                ]
            }
        )
        + "data: [DONE]\n\n",
        "data: {invalid}\n\n",
    ],
)
async def test_chat_rejects_incomplete(source):
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(200, stream=Chunks(source)))
    ) as client:
        provider = DeepSeekProvider(api_key="key", client=client)
        with pytest.raises(ArborError):
            await collect(provider)


@pytest.mark.parametrize("model", ["kimi-k3", "kimi/kimi-k3", "qwen3.8-27b"])
async def test_bailian_preserves_model_id_and_provider_parameters(model):
    sent = []

    async def handler(request):
        sent.append((str(request.url), json.loads(request.content)))
        return httpx.Response(
            200,
            stream=Chunks(event({"choices": [{"delta": {}, "finish_reason": "stop"}]}) + "data: [DONE]\n\n"),
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        provider = BailianProvider(api_key="key", model=model, client=client)
        await collect(provider)
        assert sent[0][0] == "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
        assert sent[0][1]["model"] == model
        assert "thinking" not in sent[0][1] and "enable_thinking" not in sent[0][1]
        provider.enable_thinking = False
        await collect(provider)
        assert sent[1][1]["enable_thinking"] is False


async def test_compatible_requests_are_neutral_and_http_errors_hide_body():
    sent = []

    async def handler(request):
        sent.append(json.loads(request.content))
        return httpx.Response(401, content=b"private-key")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        provider = ChatCompletionsProvider(
            api_key="private-key", model="my-model", base_url="https://example.com/v1", client=client
        )
        with pytest.raises(ArborError, match="HTTP 401") as error:
            await collect(provider)
        assert "private-key" not in str(error.value)
        assert "thinking" not in sent[0] and "enable_thinking" not in sent[0]


@pytest.mark.parametrize(
    "base",
    ["http://example.com", "https://user:password@example.com", "https://example.com?key=secret", "bad-url"],
)
def test_invalid_endpoints(base):
    with pytest.raises(ArborError):
        ResponsesProvider(api_key="key", model="model", base_url=base)


async def test_request_timeout_and_cancellation_close_stream():
    class Waiting(httpx.AsyncByteStream):
        def __init__(self):
            self.closed = False

        async def __aiter__(self):
            await asyncio.sleep(30)
            yield b""

        async def aclose(self):
            self.closed = True

    chunks = Waiting()
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(200, stream=chunks))
    ) as client:
        provider = ResponsesProvider(
            api_key="key", model="model", base_url="https://example.com/v1", client=client, timeout=0.02
        )
        with pytest.raises(ArborError) as error:
            await collect(provider)
        assert error.value.code == "provider_timeout" and chunks.closed
        chunks.closed = False
        provider._timeout = 30
        task = asyncio.create_task(collect(provider))
        await asyncio.sleep(0.02)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert chunks.closed
