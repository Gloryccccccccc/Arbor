import asyncio
import json
import os
import sys

import pytest

from arbor.errors import ArborError
from arbor.tools import ArtifactStore, LocalOperations, ToolExecutor, coding_tools, sha256


@pytest.fixture
def ops(tmp_path):
    artifacts = ArtifactStore(tmp_path / ".arbor", "test-session")
    return LocalOperations(tmp_path, tmp_path / ".arbor", artifacts)


async def noop(*args):
    pass


async def test_read_hash_edit_and_conflict(ops):
    (ops.cwd / "a.py").write_bytes(b"first\r\nsecond\r\nthird\r\n")
    result = await ops.read("a.py", 2, 2)
    assert result["content"] == "second"
    assert result["sha256"] == sha256(b"first\r\nsecond\r\nthird\r\n")
    await ops.edit("a.py", "second", "updated", result["sha256"])
    assert (ops.cwd / "a.py").read_bytes() == b"first\r\nupdated\r\nthird\r\n"
    with pytest.raises(ArborError, match="changed"):
        await ops.edit("a.py", "third", "wrong", result["sha256"])


async def test_ambiguous_edit_and_existing_file(ops):
    (ops.cwd / "a").write_text("same same")
    with pytest.raises(ArborError) as error:
        await ops.edit("a", "same", "new", sha256("same same"))
    assert error.value.code == "edit_match"
    with pytest.raises(ArborError) as error:
        await ops.write("a", "overwrite")
    assert error.value.code == "file_conflict"
    assert (ops.cwd / "a").read_text() == "same same"


async def test_new_directory_and_empty_existing_file(ops):
    await ops.write("nested/a.py", "hello")
    (ops.cwd / "empty").touch()
    with pytest.raises(ArborError):
        await ops.write("empty", "overwrite")
    await ops.write("empty", "safe", sha256(""))
    assert (ops.cwd / "empty").read_text() == "safe"


@pytest.mark.parametrize(
    "path", ["../outside", ".git/config", ".env", ".env.local", ".arbor/state", "secret.pem", r"C:\outside"]
)
async def test_protected_paths(ops, path):
    with pytest.raises(ArborError) as error:
        await ops.write(path, "bad")
    assert error.value.code == "path_denied"


async def test_symlink_escape(ops, tmp_path):
    outside = tmp_path.parent / (tmp_path.name + "-outside")
    outside.mkdir()
    (outside / "secret").write_text("secret")
    link = ops.cwd / "escape"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except OSError:
        if sys.platform != "win32":
            raise
        import subprocess

        await asyncio.to_thread(
            subprocess.run,
            ["cmd", "/c", "mklink", "/J", str(link), str(outside)],
            capture_output=True,
            check=True,
        )
    with pytest.raises(ArborError) as error:
        await ops.read("escape/secret")
    assert error.value.code == "path_denied"


async def test_artifact_scope_and_ranges(ops):
    artifact = ops.artifacts.put("first\nsecond\n")
    assert (await ops.read("artifact:" + artifact, 2, 2))["content"] == "second"
    with pytest.raises(ArborError) as error:
        await ops.read("artifact:../../anything")
    assert error.value.code == "artifact_id"


async def test_unicode_pages_remain_readable(ops):
    source = "中" * 5000 + "TAIL"
    artifact = ops.artifacts.put(source)
    executor = ToolExecutor(coding_tools(ops), "read-only", ops.artifacts, lambda _: None, noop)
    offset = 0
    restored = ""
    for index in range(10):
        result = await executor.execute(
            {
                "id": str(index),
                "name": "read",
                "arguments": {"path": "artifact:" + artifact, "offset": offset},
            },
            "run",
        )
        assert len(result["content"].encode()) <= 12_000
        page = json.loads(result["content"])
        assert "artifactId" not in page
        restored += page["content"]
        if page["nextOffset"] is None:
            break
        offset = page["nextOffset"]
    assert restored == source


@pytest.mark.parametrize("permission", ["ask", "read-only"])
async def test_denial_precedes_intent_and_write(ops, permission):
    dispatched = []

    async def before(*args):
        dispatched.append(args)

    async def deny(*args):
        return False

    executor = ToolExecutor(coding_tools(ops), permission, ops.artifacts, lambda _: None, before, deny)
    result = await executor.execute(
        {"id": "w", "name": "write", "arguments": {"path": "a", "content": "bad"}}, "run"
    )
    assert result["isError"]
    assert "permission_denied" in result["content"]
    assert not dispatched and not (ops.cwd / "a").exists()


@pytest.mark.parametrize(
    "arguments",
    [
        {"command": "echo test", "timeoutMs": "1000"},
        {"command": "echo test", "timeoutMs": True},
        {"command": "echo test", "extra": 1},
    ],
)
async def test_schema_before_approval_no_coercion(ops, arguments):
    async def never(*args):
        pytest.fail("must not approve or dispatch")

    executor = ToolExecutor(coding_tools(ops), "ask", ops.artifacts, lambda _: None, never, never)
    result = await executor.execute({"id": "e", "name": "exec", "arguments": arguments}, "run")
    assert "schema_error" in result["content"]


async def test_approval_timeout(ops):
    async def wait(*args):
        await asyncio.sleep(5)
        return True

    executor = ToolExecutor(coding_tools(ops), "ask", ops.artifacts, lambda _: None, noop, wait, 0.02)
    result = await executor.execute(
        {"id": "w", "name": "write", "arguments": {"path": "a", "content": "bad"}}, "run"
    )
    assert "permission_denied" in result["content"]
    assert not (ops.cwd / "a").exists()


async def test_exit_code_credentials_and_unicode(ops, monkeypatch):
    for key in ("ARBOR_API_KEY", "DASHSCOPE_API_KEY", "DEEPSEEK_API_KEY"):
        monkeypatch.setenv(key, "do-not-inherit")
    result = await ops.exec(
        "python -c \"import os,sys; print(any(k.endswith('API_KEY') for k in os.environ)); sys.exit(7)\""
    )
    assert result["exitCode"] == 7 and result["stdout"].strip() == "False"
    command = "Write-Output '中文反馈'" if os.name == "nt" else "printf '中文反馈'"
    result = await ops.exec(command)
    assert result["exitCode"] == 0 and result["stdout"].strip() == "中文反馈"


async def test_bounded_output_and_raw_artifact(ops):
    result = await ops.exec("python -c \"print('x'*20000+'TAIL',end='')\"")
    assert result["exitCode"] == 0
    assert result["outputTruncated"] and result["stdout"].endswith("TAIL")
    assert len(result["stdout"].encode()) < 9000
    assert ops.artifacts.read(result["artifactId"]) == "x" * 20000 + "TAIL"


async def test_command_timeout_and_cancel(ops):
    result = await ops.exec('python -c "import time; time.sleep(20)"', 400)
    assert result["timedOut"] and not result["cleanupError"]
    running = asyncio.create_task(ops.exec('python -c "import time; time.sleep(20)"'))
    await asyncio.sleep(0.4)
    running.cancel()
    result = await running
    assert result["cancelled"] and not result["cleanupError"]


async def test_already_cancelled_write_does_not_execute(ops):
    async def cancel_then_write():
        asyncio.current_task().cancel()
        await ops.write("blocked", "bad")

    task = asyncio.create_task(cancel_then_write())
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not (ops.cwd / "blocked").exists()
