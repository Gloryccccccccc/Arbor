from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import asdict, dataclass
from typing import Any, Literal, Protocol

Message = dict[str, Any]
ToolCall = dict[str, Any]
Event = dict[str, Any]
PermissionMode = Literal["ask", "read-only", "trusted"]


@dataclass(frozen=True)
class ModelRequest:
    system: str
    messages: list[Message]
    tools: list[dict[str, Any]]
    max_output_tokens: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "system": self.system,
            "messages": self.messages,
            "tools": self.tools,
            "maxOutputTokens": self.max_output_tokens,
        }


class ModelProvider(Protocol):
    id: str
    model: str
    context_window: int

    def stream(self, request: ModelRequest) -> AsyncIterator[Event]: ...


@dataclass(frozen=True)
class RunBudget:
    max_turns: int = 20
    max_tool_calls: int = 50
    max_duration_ms: int = 300_000
    max_total_tokens: int = 100_000
    max_output_tokens: int = 4096

    def __post_init__(self) -> None:
        for name, value in asdict(self).items():
            if type(value) is not int or value <= 0:
                raise ValueError(f"{name} must be a positive integer")


@dataclass
class RunResult:
    run_id: str
    session_id: str
    stop_reason: str = "model_stop"
    final_text: str = ""
    turns: int = 0
    tool_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    usage_estimated: bool = False
    verification: str = "not_requested"
    error: dict[str, str] | None = None

    def to_dict(self) -> dict[str, Any]:
        result = {
            "runId": self.run_id,
            "sessionId": self.session_id,
            "stopReason": self.stop_reason,
            "finalText": self.final_text,
            "turns": self.turns,
            "toolCalls": self.tool_calls,
            "usage": {"inputTokens": self.input_tokens, "outputTokens": self.output_tokens},
            "usageEstimated": self.usage_estimated,
            "verification": self.verification,
        }
        if self.error:
            result["error"] = self.error
        return result


@dataclass(frozen=True)
class ApprovalRequest:
    run_id: str
    call: ToolCall
    effect: str


ApprovalHandler = Callable[[ApprovalRequest], Awaitable[bool]]


def validate_message(message: Any) -> None:
    from .errors import ArborError

    if not isinstance(message, dict) or not isinstance(message.get("content"), str):
        raise ArborError("provider_protocol", "Invalid model message.")
    role = message.get("role")
    if role == "user":
        return
    if role == "tool":
        if (
            not isinstance(message.get("toolCallId"), str)
            or not isinstance(message.get("name"), str)
            or type(message.get("isError")) is not bool
        ):
            raise ArborError("provider_protocol", "Invalid tool result.")
        return
    calls = message.get("toolCalls")
    if role != "assistant" or not isinstance(calls, list) or len(calls) > 32:
        raise ArborError("provider_protocol", "Invalid assistant response.")
    if "reasoningContent" in message and not isinstance(message["reasoningContent"], str):
        raise ArborError("provider_protocol", "Invalid reasoning field.")
    if "providerState" in message:
        state = message["providerState"]
        if (
            not isinstance(state, dict)
            or state.get("protocol") != "responses"
            or not isinstance(state.get("output"), list)
        ):
            raise ArborError("provider_protocol", "Invalid provider state.")
    ids: set[str] = set()
    for call in calls:
        if (
            not isinstance(call, dict)
            or not isinstance(call.get("id"), str)
            or not call["id"]
            or call["id"] in ids
            or not isinstance(call.get("name"), str)
            or not call["name"]
            or "arguments" not in call
        ):
            raise ArborError("provider_protocol", "Invalid or duplicate tool call identity.")
        ids.add(call["id"])
