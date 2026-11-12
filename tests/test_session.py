import json

import pytest
from conftest import call, reply

from arbor.context import dumps
from arbor.errors import ArborError
from arbor.session import SessionStore


async def create(tmp_path):
    data = tmp_path / ".arbor"
    return await SessionStore.create(
        data, cwd=str(tmp_path), system="Rules", provider={"id": "fake", "model": "test"}
    ), data


async def test_save_resume_and_notes(tmp_path):
    store, data = await create(tmp_path)
    identity = store.header["id"]
    await store.append({"type": "message", "message": {"role": "user", "content": "goal"}})
    await store.append({"type": "message", "message": reply("Recorded")})
    await store.append({"type": "note", "content": "Keep async API"})
    await store.close()
    resumed = await SessionStore.resume(data, identity)
    assert [p["message"]["content"] for p in resumed.project()] == ["goal", "Recorded"]
    assert resumed.notes() == ["Keep async API"]
    await resumed.close()


async def test_single_writer(tmp_path):
    store, data = await create(tmp_path)
    try:
        with pytest.raises(ArborError) as error:
            await SessionStore.resume(data, store.header["id"])
        assert error.value.code == "session_locked"
    finally:
        await store.close()


async def test_partial_tail_backed_up(tmp_path):
    store, data = await create(tmp_path)
    identity, path = store.header["id"], store.path
    await store.append({"type": "message", "message": reply("saved")})
    await store.close()
    with path.open("ab") as stream:
        stream.write(b'{"partial":')
    resumed = await SessionStore.resume(data, identity)
    assert resumed.project()[0]["message"]["content"] == "saved"
    assert list((data / "recovery").glob("*.partial"))[0].read_bytes() == b'{"partial":'
    assert path.read_bytes().endswith(b"\n")
    await resumed.close()


@pytest.mark.parametrize("corruption", [b"{broken}\n", b'{"type":"unknown"}\n'])
async def test_complete_corruption_not_overwritten(tmp_path, corruption):
    store, data = await create(tmp_path)
    identity, path = store.header["id"], store.path
    await store.close()
    with path.open("ab") as stream:
        stream.write(corruption)
    original = path.read_bytes()
    with pytest.raises(ArborError) as error:
        await SessionStore.resume(data, identity)
    assert error.value.code == "session_corrupt"
    assert path.read_bytes() == original


@pytest.mark.parametrize("dispatched", [True, False])
async def test_interrupted_batch_is_paired_without_replay(tmp_path, dispatched):
    store, data = await create(tmp_path)
    identity = store.header["id"]
    operation = call("write", {"path": "a", "content": "bad"})
    await store.append({"type": "run_start", "runId": "run"})
    await store.append({"type": "message", "message": reply("", [operation])})
    if dispatched:
        await store.append({"type": "operation_start", "runId": "run", "call": operation})
    await store.close()
    resumed = await SessionStore.resume(data, identity)
    result = resumed.project()[-1]["message"]
    assert result["role"] == "tool" and result["isError"]
    assert json.loads(result["content"])["error"] == (
        "interrupted_unknown_effect" if dispatched else "interrupted_before_dispatch"
    )
    assert not (tmp_path / "a").exists()
    assert resumed.records()[-1]["type"] == "run_end"
    await resumed.close()


async def test_legacy_typescript_format_and_listing(tmp_path):
    store, data = await create(tmp_path)
    identity, path = store.header["id"], store.path
    await store.close()
    header = json.loads(path.read_bytes())
    # Legacy TypeScript serialized camelCase fields and optional provider metadata.
    entry = {
        "id": "0d31f183-8ab8-4585-aa9b-c2f084445e52",
        "parentId": None,
        "seq": 1,
        "timestamp": "2026-11-12T00:00:00.000Z",
        "type": "message",
        "message": {
            "role": "assistant",
            "content": "legacy reply",
            "toolCalls": [],
            "reasoningContent": "retained",
        },
    }
    path.write_bytes((dumps(header) + "\n" + dumps(entry) + "\n").encode())
    resumed = await SessionStore.resume(data, identity)
    assert resumed.project()[0]["message"]["reasoningContent"] == "retained"
    assert SessionStore.list(data)[0]["id"] == identity
    await resumed.close()
