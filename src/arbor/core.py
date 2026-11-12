import asyncio
from collections.abc import Callable
from typing import Any, Protocol

from .context import dumps, estimate_tokens, request_fits
from .errors import ArborError, error_info
from .types import (
    Event,
    Message,
    ModelProvider,
    ModelRequest,
    RunBudget,
    RunResult,
    ToolCall,
    validate_message,
)


class LoopHost(Protocol):
    def build_request(self, max_output_tokens: int) -> ModelRequest: ...
    async def append_message(self, message: Message) -> None: ...
    async def execute_tool(self, call: ToolCall, run_id: str) -> Message: ...
    async def save_tool_result(self, message: Message, run_id: str) -> None: ...
    def take_steering(self) -> list[str]: ...
    def has_steering(self) -> bool: ...
    def emit(self, event: Event) -> None: ...


async def run_agent_loop(
    *,
    run_id: str,
    session_id: str,
    provider: ModelProvider,
    budget: RunBudget,
    host: LoopHost,
    cancelled: Callable[[], bool] = lambda: False,
) -> RunResult:
    """Schedule model turns and tools without depending on terminals, files or a wire protocol."""
    result = RunResult(run_id, session_id)
    errors: dict[str, int] = {}
    cleanup_unconfirmed = False
    timer = asyncio.timeout(budget.max_duration_ms / 1000)
    try:
        async with timer:
            while True:
                await asyncio.sleep(0)
                if cancelled() or timer.expired():
                    result.stop_reason = "timeout" if timer.expired() else "cancelled"
                    break
                for content in host.take_steering():
                    await host.append_message({"role": "user", "content": content})
                if result.turns >= budget.max_turns or result.tool_calls >= budget.max_tool_calls:
                    result.stop_reason = "budget"
                    break
                request = host.build_request(budget.max_output_tokens)
                estimated = estimate_tokens(request.to_dict())
                if not request_fits(request, provider.context_window):
                    raise ArborError(
                        "context_budget", "The context is too large. Run /compact or start a new session."
                    )
                if (
                    result.input_tokens + result.output_tokens + estimated + request.max_output_tokens
                    > budget.max_total_tokens
                ):
                    result.stop_reason = "budget"
                    break
                result.turns += 1
                host.emit({"type": "turn_started", "runId": run_id, "turn": result.turns})
                response = None
                usage: dict[str, Any] | None = None
                visible = ""
                iterator = provider.stream(request)
                try:
                    async for event in iterator:
                        if response is not None:
                            raise ArborError(
                                "provider_protocol", "The provider emitted data after its response."
                            )
                        if event["type"] == "text_delta":
                            visible += event["text"]
                            host.emit({**event, "runId": run_id})
                        elif event["type"] == "tool_delta":
                            visible += event["argumentsDelta"]
                            host.emit({**event, "runId": run_id})
                        elif event["type"] == "response":
                            response, usage = event["message"], event.get("usage")
                finally:
                    if close := getattr(iterator, "aclose", None):
                        await close()
                    measured = usage is not None and all(
                        type(usage.get(k)) is int and usage[k] >= 0 for k in ("inputTokens", "outputTokens")
                    )
                    result.input_tokens += usage["inputTokens"] if measured and usage else estimated
                    result.output_tokens += (
                        usage["outputTokens"]
                        if measured and usage
                        else estimate_tokens(response)
                        if response
                        else (len(visible.encode()) + 1) // 2
                    )
                    result.usage_estimated |= not measured
                if response is None:
                    raise ArborError("provider_incomplete", "The provider returned no complete response.")
                validate_message(response)
                dumps(response)
                await host.append_message(response)
                host.emit({"type": "message_saved", "runId": run_id, "message": response})
                if not response["toolCalls"]:
                    result.final_text = response["content"]
                    host.emit({"type": "turn_finished", "runId": run_id, "turn": result.turns})
                    if host.has_steering():
                        continue
                    break
                stop_batch = False
                for call in response["toolCalls"]:
                    if (
                        cancelled()
                        or timer.expired()
                        or stop_batch
                        or result.tool_calls >= budget.max_tool_calls
                    ):
                        error = (
                            "cancelled_before_dispatch"
                            if cancelled() or timer.expired()
                            else "budget_before_dispatch"
                        )
                        message = {
                            "role": "tool",
                            "toolCallId": call["id"],
                            "name": call["name"],
                            "isError": True,
                            "content": dumps({"error": error, "message": "This call was not executed."}),
                        }
                        stop_batch = True
                        result.stop_reason = (
                            "timeout" if timer.expired() else "cancelled" if cancelled() else "budget"
                        )
                    else:
                        result.tool_calls += 1
                        message = await host.execute_tool(call, run_id)
                    await host.save_tool_result(message, run_id)
                    if message.get("execution", {}).get("cleanupError"):
                        cleanup_unconfirmed = True
                        stop_batch = True
                    if message["isError"]:
                        key = dumps([call["name"], call["arguments"], message["content"]])
                        errors[key] = errors.get(key, 0) + 1
                        if errors[key] >= 3:
                            stop_batch = True
                            result.stop_reason = "budget"
                host.emit({"type": "turn_finished", "runId": run_id, "turn": result.turns})
                if cleanup_unconfirmed:
                    raise ArborError("cleanup_unconfirmed", "Local process cleanup could not be confirmed.")
                if cancelled() or timer.expired():
                    result.stop_reason = "timeout" if timer.expired() else "cancelled"
                    break
                if stop_batch or result.input_tokens + result.output_tokens >= budget.max_total_tokens:
                    result.stop_reason = "budget"
                    break
    except (asyncio.CancelledError, TimeoutError):
        result.stop_reason = "timeout" if timer.expired() else "cancelled"
    except Exception as error:
        result.stop_reason, result.error = "error", error_info(error)
    return result
