"""Arbor: a lightweight runtime for coding agents."""

from .coding_session import CodingSession, create_coding_session
from .core import LoopHost, run_agent_loop
from .errors import ArborError
from .models import BailianProvider, ChatCompletionsProvider, DeepSeekProvider, ResponsesProvider
from .session import SessionStore
from .tools import ToolDefinition, ToolRegistry
from .types import ApprovalRequest, ModelProvider, ModelRequest, RunBudget, RunResult

__version__ = "0.2.0"
__all__ = [
    "ApprovalRequest",
    "ArborError",
    "BailianProvider",
    "ChatCompletionsProvider",
    "CodingSession",
    "DeepSeekProvider",
    "LoopHost",
    "ModelProvider",
    "ModelRequest",
    "ResponsesProvider",
    "RunBudget",
    "RunResult",
    "SessionStore",
    "ToolDefinition",
    "ToolRegistry",
    "create_coding_session",
    "run_agent_loop",
]
