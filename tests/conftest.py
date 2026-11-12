import copy
import inspect
import tempfile
from pathlib import Path
from typing import Any

import pytest

from arbor.types import ModelRequest

ROOT = Path(__file__).resolve().parent.parent
TEMP = ROOT / ".work" / "tmp"
TEMP.mkdir(parents=True, exist_ok=True)
tempfile.tempdir = str(TEMP)


def reply(content: str, calls: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {"role": "assistant", "content": content, "toolCalls": calls or []}


def call(name: str, arguments: Any, identity: str = "call-1") -> dict[str, Any]:
    return {"id": identity, "name": name, "arguments": arguments}


class FakeProvider:
    id = "fake"
    model = "test-model"
    context_window = 100_000

    def __init__(self, steps: list[Any]):
        self.steps = steps[:]
        self.requests: list[ModelRequest] = []
        self.usage: dict[str, int] | None = {"inputTokens": 10, "outputTokens": 5}

    async def stream(self, request: ModelRequest):
        self.requests.append(copy.deepcopy(request))
        step = self.steps.pop(0)
        if isinstance(step, Exception):
            raise step
        message = step(request) if callable(step) else step
        if inspect.isawaitable(message):
            message = await message
        if message["content"]:
            yield {"type": "text_delta", "text": message["content"]}
        yield {"type": "response", "message": message, "usage": self.usage}


@pytest.fixture
def fake():
    return FakeProvider


@pytest.fixture
def summary():
    return {
        "goal": "Fix the project",
        "constraints": ["Keep public interfaces"],
        "completed": ["Read source"],
        "openIssues": ["Run tests"],
        "nextSteps": ["Verify"],
        "references": ["source.py"],
    }
