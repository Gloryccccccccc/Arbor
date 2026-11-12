import asyncio
import json

import pytest
from conftest import call, reply

from arbor import (
    ArborError,
    ResponsesProvider,
    RunBudget,
    ToolDefinition,
    ToolRegistry,
    create_coding_session,
)
from arbor.context import dumps


async def test_real_read_failing_test_edit_passing_test(tmp_path, fake):
    original = "def timeout(options):\n    return options.get('timeout') or 1000\n"
    (tmp_path / "timeout.py").write_text(original)
    (tmp_path / "test_timeout.py").write_text(
        "import unittest\nfrom timeout import timeout\n"
        "class TimeoutTest(unittest.TestCase):\n"
        "    def test_zero(self): self.assertEqual(timeout({'timeout': 0}), 0)\n"
        "    def test_default(self): self.assertEqual(timeout({}), 1000)\n"
    )

    def fix(request):
        read = next(m for m in request.messages if m["role"] == "tool" and m["name"] == "read")
        assert request.messages[-1]["isError"]
        return reply(
            "Fix",
            [
                call(
                    "edit",
                    {
                        "path": "timeout.py",
                        "oldText": "options.get('timeout') or 1000",
                        "newText": "options.get('timeout', 1000)",
                        "expectedHash": json.loads(read["content"])["sha256"],
                    },
                    "edit",
                )
            ],
        )

    def verified(request):
        result = json.loads(request.messages[-1]["content"])
        assert result["exitCode"] == 0
        return reply("Tests passed.")

    provider = fake(
        [
            reply("Read", [call("read", {"path": "timeout.py"}, "read")]),
            reply("Baseline", [call("exec", {"command": "python -m unittest -q"}, "baseline")]),
            fix,
            reply("Verify", [call("exec", {"command": "python -m unittest -q"}, "verify")]),
            verified,
        ]
    )
    async with await create_coding_session(cwd=tmp_path, provider=provider, permissions="trusted") as session:
        events = []
        session.subscribe(events.append)
        result = await session.prompt("Fix the failing test while preserving zero.")
        assert result.stop_reason == "model_stop" and result.turns == 5 and result.tool_calls == 4
        assert result.verification == "not_requested"
        assert (tmp_path / "timeout.py").read_text() != original
        assert sum(e["type"] == "turn_finished" for e in events) == 5
        assert sum(e["type"] == "operation_start" for e in session.store.records()) == 4


async def test_intent_and_call_persist_before_execution(tmp_path, fake):
    registry = ToolRegistry()
    path = None

    async def probe(arguments, run_id):
        assert '"type":"operation_start"' in path.read_text()
        assert '"name":"probe"' in path.read_text()
        return "ok"

    registry.register(ToolDefinition("probe", "Probe", {"type": "object"}, "read", probe))
    async with await create_coding_session(
        cwd=tmp_path, provider=fake([reply("", [call("probe", {})]), reply("done")]), registry=registry
    ) as session:
        path = session.store.path
        assert (await session.prompt("Probe")).stop_reason == "model_stop"


async def test_partial_model_response_never_executes(tmp_path):
    class Broken:
        id = model = "broken"
        context_window = 64_000

        async def stream(self, request):
            yield {"type": "text_delta", "text": "partial"}
            yield {"type": "tool_delta", "index": 0, "argumentsDelta": '{"path":'}
            raise ArborError("provider_incomplete", "Disconnected")

    async with await create_coding_session(cwd=tmp_path, provider=Broken(), permissions="trusted") as session:
        result = await session.prompt("task")
        assert result.stop_reason == "error" and result.tool_calls == 0
        assert result.usage_estimated and result.output_tokens > 0
        assert not any(e["type"] == "operation_start" for e in session.store.records())


async def test_tool_budget_pairs_every_saved_call(tmp_path, fake):
    provider = fake(
        [reply("", [call("read", {"path": "a"}, "first"), call("read", {"path": "a"}, "second")])]
    )
    (tmp_path / "a").write_text("evidence")
    async with await create_coding_session(
        cwd=tmp_path, provider=provider, budget=RunBudget(max_tool_calls=1)
    ) as session:
        result = await session.prompt("task")
        assert result.stop_reason == "budget" and result.tool_calls == 1
        results = [p["message"] for p in session.store.project() if p["message"]["role"] == "tool"]
        assert len(results) == 2 and "budget_before_dispatch" in results[-1]["content"]


async def test_repeated_failures_stop(tmp_path, fake):
    provider = fake([reply("", [call("missing", {}, str(i))]) for i in range(3)])
    async with await create_coding_session(cwd=tmp_path, provider=provider) as session:
        result = await session.prompt("task")
        assert result.stop_reason == "budget" and result.tool_calls == 3
        assert all(p["message"]["isError"] for p in session.store.project() if p["message"]["role"] == "tool")


async def test_token_budget_stops_before_model(tmp_path, fake):
    provider = fake([])
    async with await create_coding_session(
        cwd=tmp_path, provider=provider, budget=RunBudget(max_total_tokens=1)
    ) as session:
        assert (await session.prompt("task")).stop_reason == "budget"
        assert not provider.requests


async def test_context_limit_is_reported(tmp_path, fake):
    provider = fake([])
    provider.context_window = 10
    async with await create_coding_session(cwd=tmp_path, provider=provider) as session:
        result = await session.prompt("task")
        assert result.error["code"] == "context_budget" and not provider.requests


async def test_steering_is_persisted_at_next_boundary_and_busy_rejects(tmp_path, fake):
    entered, release = asyncio.Event(), asyncio.Event()

    async def wait(request):
        entered.set()
        await release.wait()
        return reply("first")

    provider = fake([wait, reply("continued")])
    async with await create_coding_session(cwd=tmp_path, provider=provider) as session:
        running = asyncio.create_task(session.prompt("task"))
        await entered.wait()
        with pytest.raises(ArborError) as error:
            await session.prompt("overlap")
        assert error.value.code == "session_busy"
        session.steer("keep public API")
        release.set()
        assert (await running).final_text == "continued"
        assert provider.requests[-1].messages[-1]["content"] == "keep public API"


async def test_abort_model_then_next_prompt(tmp_path, fake):
    entered = asyncio.Event()

    async def wait(request):
        entered.set()
        await asyncio.Future()

    provider = fake([wait, reply("next")])
    async with await create_coding_session(cwd=tmp_path, provider=provider) as session:
        events = []
        session.subscribe(events.append)
        running = asyncio.create_task(session.prompt("task"))
        await entered.wait()
        session.steer("unconsumed correction")
        await session.abort()
        assert (await running).stop_reason == "cancelled"
        assert any(
            e["type"] == "steering_returned" and e["inputs"] == ["unconsumed correction"] for e in events
        )
        assert (await session.prompt("again")).final_text == "next"


async def test_abort_before_first_model_turn(tmp_path, fake):
    async with await create_coding_session(cwd=tmp_path, provider=fake([])) as session:
        running = asyncio.create_task(session.prompt("task"))
        await asyncio.sleep(0)
        await session.abort()
        assert (await running).stop_reason == "cancelled"


async def test_run_deadline_during_model(tmp_path, fake):
    async def wait(request):
        await asyncio.Future()

    async with await create_coding_session(
        cwd=tmp_path, provider=fake([wait]), budget=RunBudget(max_duration_ms=30)
    ) as session:
        assert (await session.prompt("task")).stop_reason == "timeout"


async def test_abort_real_shell_is_recorded(tmp_path, fake):
    provider = fake([reply("", [call("exec", {"command": 'python -c "import time; time.sleep(30)"'})])])
    async with await create_coding_session(cwd=tmp_path, provider=provider, permissions="trusted") as session:
        entered = asyncio.Event()
        session.subscribe(lambda e: entered.set() if e["type"] == "tool_started" else None)
        running = asyncio.create_task(session.prompt("task"))
        await entered.wait()
        await asyncio.sleep(0.4)
        await session.abort()
        result = await running
        assert result.stop_reason == "cancelled"
        tool = next(p["message"] for p in session.store.project() if p["message"]["role"] == "tool")
        assert json.loads(tool["content"])["cancelled"] and not tool["execution"]["cleanupError"]


async def test_cleanup_uncertainty_is_an_error(tmp_path, fake):
    registry = ToolRegistry()

    async def execute(*args):
        return {"exitCode": None, "timedOut": False, "cancelled": True, "cleanupError": True}

    registry.register(ToolDefinition("probe", "Probe", {"type": "object"}, "exec", execute))
    async with await create_coding_session(
        cwd=tmp_path,
        provider=fake([reply("", [call("probe", {})])]),
        registry=registry,
        permissions="trusted",
    ) as session:
        result = await session.prompt("task")
        assert result.stop_reason == "error" and result.error["code"] == "cleanup_unconfirmed"


async def build_history(session):
    for text in ("one", "two", "three", "four"):
        await session.prompt(text)


async def test_compaction_keeps_complete_recent_batch_notes_and_originals(tmp_path, fake, summary):
    (tmp_path / "a").write_text("source")

    def summarize(request):
        assert not request.tools
        assert "opaque-fixture" not in request.messages[0]["content"]
        assert "private-reasoning" not in request.messages[0]["content"]
        return reply(dumps(summary))

    provider = fake(
        [
            {
                **reply("A"),
                "reasoningContent": "private-reasoning",
                "providerState": {
                    "protocol": "responses",
                    "output": [{"type": "reasoning", "encrypted_content": "opaque-fixture"}],
                },
            },
            reply("B"),
            reply("C"),
            reply("", [call("read", {"path": "a"})]),
            reply("D"),
            summarize,
            reply("continued"),
        ]
    )
    async with await create_coding_session(cwd=tmp_path, provider=provider) as session:
        await session.note("Keep async API")
        await build_history(session)
        original = session.store.path.read_bytes()
        report = await session.compact(2)
        assert report["keptMessages"] == 3
        assert [p["message"]["role"] for p in session.store.project()] == [
            "user",
            "assistant",
            "tool",
            "assistant",
        ]
        assert session.store.path.read_bytes().startswith(original)
        assert (await session.prompt("Continue")).final_text == "continued"
        assert "Keep async API" in provider.requests[-1].system


async def test_invalid_summary_preserves_projection(tmp_path, fake):
    provider = fake([reply(t) for t in "ABCD"] + [reply('{"goal":"missing fields"}')])
    async with await create_coding_session(cwd=tmp_path, provider=provider) as session:
        await build_history(session)
        before = session.store.project()
        with pytest.raises(ArborError) as error:
            await session.compact(2)
        assert error.value.code == "summary_invalid" and session.store.project() == before


async def test_compacted_history_survives_resume(tmp_path, fake, summary):
    provider = fake([reply(t) for t in "ABCD"] + [reply(dumps(summary)), reply("resumed")])
    async with await create_coding_session(cwd=tmp_path, provider=provider) as session:
        await build_history(session)
        await session.compact(2)
        identity = session.id
    async with await create_coding_session(cwd=tmp_path, provider=provider, resume=identity) as resumed:
        assert (await resumed.prompt("Continue")).final_text == "resumed"
        assert "Historical summary" in provider.requests[-1].messages[0]["content"]


async def test_dispose_cancels_compaction_without_committing_it(tmp_path, fake):
    entered = asyncio.Event()

    async def wait(request):
        entered.set()
        await asyncio.Future()

    provider = fake([reply(t) for t in "ABCD"] + [wait])
    session = await create_coding_session(cwd=tmp_path, provider=provider)
    await build_history(session)
    task = asyncio.create_task(session.compact(2))
    await entered.wait()
    await asyncio.wait_for(session.dispose(), 1)
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not any(e["type"] == "compaction" for e in session.store.records())


async def test_resume_rejects_changed_endpoint(tmp_path):
    async with ResponsesProvider(api_key="test", model="model", base_url="https://first.example/v1") as first:
        async with await create_coding_session(cwd=tmp_path, provider=first) as session:
            identity = session.id
    async with ResponsesProvider(
        api_key="test", model="model", base_url="https://second.example/v1"
    ) as second:
        with pytest.raises(ArborError) as error:
            await create_coding_session(cwd=tmp_path, provider=second, resume=identity)
        assert error.value.code == "session_endpoint"
