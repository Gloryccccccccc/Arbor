import asyncio
import copy
import hashlib
import os
import re
import signal
import subprocess
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath
from typing import Any
from uuid import uuid4

from jsonschema import Draft202012Validator, ValidationError

from .context import dumps
from .errors import ArborError, error_info
from .session import ID
from .types import ApprovalHandler, ApprovalRequest, Event, Message, PermissionMode, ToolCall


def check_cancelled() -> None:
    task = asyncio.current_task()
    if task and task.cancelling():
        raise asyncio.CancelledError


def sha256(value: str | bytes) -> str:
    return hashlib.sha256(value.encode("utf-8") if isinstance(value, str) else value).hexdigest()


class ArtifactStore:
    def __init__(self, data_dir: Path, session_id: str):
        self.directory = data_dir / "artifacts" / session_id
        self.directory.mkdir(parents=True, exist_ok=True)

    def put(self, text: str) -> str:
        artifact_id = str(uuid4())
        with (self.directory / (artifact_id + ".txt")).open("xb") as stream:
            stream.write(text.encode("utf-8"))
        return artifact_id

    def read(self, artifact_id: str) -> str:
        if not ID.fullmatch(artifact_id):
            raise ArborError("artifact_id", "Invalid artifact ID.")
        return (self.directory / (artifact_id + ".txt")).read_bytes().decode("utf-8", errors="replace")


class OutputBuffer:
    def __init__(self) -> None:
        self.first = b""
        self.last = b""
        self.total = 0

    def push(self, chunk: bytes) -> None:
        self.total += len(chunk)
        self.first = (self.first + chunk)[:4096]
        self.last = (self.last + chunk)[-4096:]

    def text(self) -> str:
        if self.total <= 4096:
            raw = self.first
        elif self.total <= 8192:
            raw = self.first + self.last[-(self.total - len(self.first)) :]
        else:
            raw = self.first + b"\n... output truncated ...\n" + self.last
        return raw.decode("utf-8", errors="replace")


class LocalOperations:
    def __init__(self, cwd: Path, data_dir: Path, artifacts: ArtifactStore):
        self.cwd = cwd.resolve(strict=True)
        data_dir.mkdir(parents=True, exist_ok=True)
        self.protected_directory = data_dir.resolve()
        self.artifacts = artifacts

    def path(self, value: str, *, writing: bool = False) -> Path:
        if (
            not value
            or Path(value).is_absolute()
            or PureWindowsPath(value).drive
            or "\0" in value
            or ".." in re.split(r"[\\/]", value)
        ):
            raise ArborError("path_denied", "Use a relative path inside the selected workspace.")
        candidate = self.cwd.joinpath(*re.split(r"[\\/]", value))
        actual = candidate.resolve(strict=not writing)
        for path in (candidate, actual):
            if not path.is_relative_to(self.cwd) or path.is_relative_to(self.protected_directory):
                raise ArborError(
                    "path_denied", "The path is outside the selected workspace or is runtime state."
                )
            parts = path.relative_to(self.cwd).parts
            if any(
                p in {".git", ".arbor"} or (p.startswith(".env") and p != ".env.example") for p in parts
            ) or path.suffix.lower() in {".pem", ".key"}:
                raise ArborError("path_denied", "Credential, Git and runtime-state paths are protected.")
        return candidate

    async def read(
        self,
        path: str,
        start_line: int = 1,
        end_line: int | None = None,
        offset: int = 0,
        max_chars: int = 4000,
    ) -> dict[str, Any]:
        check_cancelled()
        if start_line < 1 or (
            end_line is not None and (end_line < start_line or end_line - start_line >= 1000)
        ):
            raise ArborError("line_range", "Read at most 1000 lines in increasing order.")
        if path.startswith("artifact:"):
            content = self.artifacts.read(path[9:])
        else:
            target = self.path(path)
            if not target.is_file():
                raise ArborError("not_a_file", "The selected path is not a file.")
            if target.stat().st_size > 1_048_576:
                raise ArborError("file_size", "Text files are limited to 1 MiB.")
            content = target.read_bytes().decode("utf-8")
        if "\0" in content:
            raise ArborError("binary_file", "Binary files are not supported by the text tools.")
        lines = re.split(r"\r?\n", content)
        end = min(end_line if end_line is not None else start_line + 199, len(lines))
        if start_line > len(lines) or end < start_line:
            raise ArborError("line_range", "The requested line range is outside the file.")
        selected = "\n".join(lines[start_line - 1 : end])
        if offset > len(selected):
            raise ArborError("read_offset", "The offset is outside the selected line range.")
        page = selected[offset : offset + max_chars]
        return {
            "path": path,
            "sha256": sha256(content),
            "totalLines": len(lines),
            "startLine": start_line,
            "endLine": end,
            "offset": offset,
            "content": page,
            "nextOffset": offset + len(page) if offset + len(page) < len(selected) else None,
        }

    async def write(self, path: str, content: str, expected_hash: str | None = None) -> dict[str, Any]:
        check_cancelled()
        raw = content.encode("utf-8")
        if len(raw) > 1_048_576:
            raise ArborError("file_size", "Writes are limited to 1 MiB.")
        target = self.path(path, writing=True)
        if target.is_symlink():
            raise ArborError("path_denied", "Select the actual file instead of writing through a symlink.")
        previous = target.read_bytes() if target.exists() else None
        if (previous is not None and (not expected_hash or sha256(previous) != expected_hash)) or (
            previous is None and expected_hash is not None
        ):
            raise ArborError(
                "file_conflict", "Read the file and supply its current sha256 before overwriting."
            )
        mode = target.stat().st_mode if previous is not None else None
        target.parent.mkdir(parents=True, exist_ok=True)
        self.path(path, writing=True)
        temporary = target.parent / (".arbor-" + str(uuid4()) + ".tmp")
        try:
            with temporary.open("xb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            if mode is not None:
                temporary.chmod(mode)
            current = target.read_bytes() if target.exists() else None
            if current != previous:
                raise ArborError("file_conflict", "The file changed while preparing the write.")
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        return {"path": path, "sha256": sha256(raw), "bytes": len(raw), "created": previous is None}

    async def edit(self, path: str, old_text: str, new_text: str, expected_hash: str) -> dict[str, Any]:
        check_cancelled()
        target = self.path(path)
        if target.stat().st_size > 1_048_576:
            raise ArborError("file_size", "Text files are limited to 1 MiB.")
        content = target.read_bytes().decode("utf-8")
        if sha256(content) != expected_hash:
            raise ArborError("file_conflict", "The file changed since it was read.")
        if not old_text or content.count(old_text) != 1:
            raise ArborError("edit_match", "oldText must match exactly one location.")
        return await self.write(path, content.replace(old_text, new_text, 1), expected_hash)

    async def _terminate(self, proc: asyncio.subprocess.Process) -> bool:
        cleanup_error = False
        if sys.platform == "win32":
            taskkill = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "taskkill.exe"
            try:
                killer = await asyncio.create_subprocess_exec(
                    str(taskkill),
                    "/PID",
                    str(proc.pid),
                    "/T",
                    "/F",
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
                await asyncio.wait_for(killer.wait(), 5)
                cleanup_error = killer.returncode != 0
            except (OSError, TimeoutError):
                cleanup_error = True
        else:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
                await asyncio.sleep(0.15)
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except OSError:
                cleanup_error = True
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        try:
            await asyncio.wait_for(proc.wait(), 5)
        except TimeoutError:
            cleanup_error = True
        return cleanup_error

    async def exec(self, command: str, timeout_ms: int = 30_000) -> dict[str, Any]:
        check_cancelled()
        allowed = {
            "PATH",
            "PATHEXT",
            "SYSTEMROOT",
            "WINDIR",
            "COMSPEC",
            "TEMP",
            "TMP",
            "HOME",
            "USERPROFILE",
            "LANG",
            "LC_ALL",
            "TERM",
        }
        env = {k: v for k, v in os.environ.items() if k.upper() in allowed}
        env["PATH"] = str(Path(sys.executable).parent) + os.pathsep + env.get("PATH", "")
        env["PYTHONIOENCODING"] = "utf-8"
        if sys.platform == "win32":
            shell = (
                Path(os.environ.get("SystemRoot", r"C:\Windows"))
                / "System32/WindowsPowerShell/v1.0/powershell.exe"
            )
            script = (
                "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); "
                "$OutputEncoding=[Console]::OutputEncoding; " + command + "\nexit $LASTEXITCODE"
            )
            args = [str(shell), "-NoProfile", "-NonInteractive", "-Command", script]
            flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            args, flags = ["/bin/sh", "-c", command], 0
        artifact_id = str(uuid4())
        output = (self.artifacts.directory / (artifact_id + ".txt")).open("xb")
        buffers = [OutputBuffer(), OutputBuffer()]
        stored = 0
        truncated = False
        readers: list[asyncio.Task[None]] = []
        cancelled = timed_out = cleanup_error = False

        async def drain(reader: asyncio.StreamReader, buffer: OutputBuffer) -> None:
            nonlocal stored, truncated
            while chunk := await reader.read(8192):
                buffer.push(chunk)
                part = chunk[: max(0, 8 * 1024 * 1024 - stored)]
                output.write(part)
                stored += len(part)
                truncated |= len(part) != len(chunk)

        proc: asyncio.subprocess.Process | None = None
        spawn = asyncio.create_task(
            asyncio.create_subprocess_exec(
                *args,
                cwd=self.cwd,
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                creationflags=flags,
                start_new_session=sys.platform != "win32",
            )
        )
        try:
            try:
                proc = await asyncio.shield(spawn)
            except asyncio.CancelledError:
                cancelled = True
                proc = await spawn
            assert proc.stdout is not None and proc.stderr is not None
            readers = [
                asyncio.create_task(drain(proc.stdout, buffers[0])),
                asyncio.create_task(drain(proc.stderr, buffers[1])),
            ]
            if not cancelled:
                try:
                    async with asyncio.timeout(timeout_ms / 1000):
                        await proc.wait()
                        await asyncio.gather(*readers)
                except TimeoutError:
                    timed_out = True
                except asyncio.CancelledError:
                    cancelled = True
            if cancelled or timed_out:
                cleanup = asyncio.create_task(self._terminate(proc))
                while True:
                    try:
                        cleanup_error = await asyncio.shield(cleanup)
                        break
                    except asyncio.CancelledError:
                        cancelled = True
                try:
                    await asyncio.wait_for(asyncio.gather(*readers, return_exceptions=True), 5)
                except TimeoutError:
                    cleanup_error = True
        except OSError:
            raise ArborError("exec_start", "The local shell could not be started.") from None
        finally:
            for reader_task in readers:
                if not reader_task.done():
                    reader_task.cancel()
            if readers:
                await asyncio.gather(*readers, return_exceptions=True)
            output.close()
        assert proc is not None
        return {
            "exitCode": proc.returncode,
            "signal": -proc.returncode if proc.returncode and proc.returncode < 0 else None,
            "stdout": buffers[0].text(),
            "stderr": buffers[1].text(),
            "timedOut": timed_out,
            "cancelled": cancelled,
            "cleanupError": cleanup_error,
            "artifactId": artifact_id,
            "artifactBytes": stored,
            "artifactTruncated": truncated,
            "outputTruncated": any(b.total > 8192 for b in buffers),
        }


@dataclass
class ToolDefinition:
    name: str
    description: str
    parameters: dict[str, Any]
    effect: str
    execute: Callable[[dict[str, Any], str], Awaitable[Any]]


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, tuple[ToolDefinition, Draft202012Validator]] = {}

    def register(self, definition: ToolDefinition) -> None:
        if (
            not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", definition.name)
            or definition.name in self._tools
        ):
            raise ArborError("tool_registration", "Invalid or duplicate tool name.")
        if definition.effect not in {"read", "write", "exec"}:
            raise ArborError("tool_registration", "Invalid tool effect.")
        Draft202012Validator.check_schema(definition.parameters)
        self._tools[definition.name] = (definition, Draft202012Validator(definition.parameters))

    def schemas(self) -> list[dict[str, Any]]:
        return copy.deepcopy(
            [
                {"name": d.name, "description": d.description, "parameters": d.parameters}
                for d, _ in self._tools.values()
            ]
        )


def coding_tools(ops: LocalOperations) -> ToolRegistry:
    registry = ToolRegistry()
    path = {"type": "string", "minLength": 1, "maxLength": 4096}
    text = {"type": "string", "maxLength": 1_048_576}
    hash_schema = {"type": "string", "pattern": "^[0-9a-f]{64}$"}

    def add(
        name: str,
        description: str,
        effect: str,
        properties: dict[str, Any],
        required: list[str],
        execute: Callable[[dict[str, Any], str], Awaitable[Any]],
    ) -> None:
        registry.register(
            ToolDefinition(
                name,
                description,
                {
                    "type": "object",
                    "properties": properties,
                    "required": required,
                    "additionalProperties": False,
                },
                effect,
                execute,
            )
        )

    add(
        "read",
        "Read workspace UTF-8 text and sha256 before editing. Default 200 lines, max 1000. "
        "For long lines use nextOffset as offset with the same line range. Supports artifact:<id>.",
        "read",
        {
            "path": path,
            "startLine": {"type": "integer", "minimum": 1},
            "endLine": {"type": "integer", "minimum": 1},
            "offset": {"type": "integer", "minimum": 0},
            "maxChars": {"type": "integer", "minimum": 1, "maximum": 8000},
        },
        ["path"],
        lambda a, _: ops.read(
            a["path"], a.get("startLine", 1), a.get("endLine"), a.get("offset", 0), a.get("maxChars", 4000)
        ),
    )
    add(
        "write",
        "Create a UTF-8 file. Overwriting requires expectedHash from a recent read. Max 1 MiB.",
        "write",
        {"path": path, "content": text, "expectedHash": hash_schema},
        ["path", "content"],
        lambda a, _: ops.write(a["path"], a["content"], a.get("expectedHash")),
    )
    add(
        "edit",
        "Replace exactly one occurrence. Read first and provide the current sha256 as expectedHash.",
        "write",
        {"path": path, "oldText": {**text, "minLength": 1}, "newText": text, "expectedHash": hash_schema},
        ["path", "oldText", "newText", "expectedHash"],
        lambda a, _: ops.edit(a["path"], a["oldText"], a["newText"], a["expectedHash"]),
    )
    add(
        "exec",
        "Run a local shell command for searches/builds/tests. Not a sandbox. Output is bounded and "
        "saved as an artifact; commands are not retried automatically.",
        "exec",
        {
            "command": {"type": "string", "minLength": 1, "maxLength": 16_384},
            "timeoutMs": {"type": "integer", "minimum": 100, "maximum": 120_000},
        },
        ["command"],
        lambda a, _: ops.exec(a["command"], a.get("timeoutMs", 30_000)),
    )
    return registry


class ToolExecutor:
    def __init__(
        self,
        registry: ToolRegistry,
        permissions: PermissionMode,
        artifacts: ArtifactStore,
        emit: Callable[[Event], None],
        before_execute: Callable[[ToolCall, str], Awaitable[Any]],
        approve: ApprovalHandler | None = None,
        approval_timeout: float = 180,
    ):
        self.registry, self.permissions, self.artifacts = registry, permissions, artifacts
        self.emit, self.before_execute, self.approve = emit, before_execute, approve
        self.approval_timeout = approval_timeout

    async def execute(self, call: ToolCall, run_id: str) -> Message:
        dispatched = False
        execution = None
        try:
            check_cancelled()
            registered = self.registry._tools.get(call["name"])
            if registered is None:
                raise ArborError("unknown_tool", "The requested tool is not registered.")
            definition, validator = registered
            try:
                validator.validate(call["arguments"])
            except ValidationError:
                raise ArborError("schema_error", "Tool arguments do not match the JSON schema.") from None
            if definition.effect != "read":
                if self.permissions == "read-only":
                    raise ArborError("permission_denied", "This session only permits read tools.")
                if self.permissions == "ask":
                    allowed = False
                    if self.approve:
                        try:
                            allowed = await asyncio.wait_for(
                                self.approve(ApprovalRequest(run_id, copy.deepcopy(call), definition.effect)),
                                self.approval_timeout,
                            )
                        except TimeoutError:
                            pass
                    if not allowed:
                        raise ArborError("permission_denied", "Tool execution was not approved.")
            check_cancelled()
            await self.before_execute(copy.deepcopy(call), run_id)
            dispatched = True
            self.emit({"type": "tool_started", "runId": run_id, "call": copy.deepcopy(call)})
            result = await definition.execute(copy.deepcopy(call["arguments"]), run_id)
            failed = definition.effect == "exec" and any(
                result.get(k) for k in ("exitCode", "timedOut", "cancelled", "cleanupError")
            )
            if definition.effect == "exec":
                execution = {
                    "cleanupError": bool(result.get("cleanupError")),
                    "timedOut": bool(result.get("timedOut")),
                }
            if call["name"] == "read" and isinstance(result, dict) and isinstance(result.get("content"), str):
                while len(dumps(result).encode()) > 12_000 and result["content"]:
                    result["content"] = result["content"][: max(1, len(result["content"]) // 2)]
                    result["nextOffset"] = result["offset"] + len(result["content"])
            content = dumps(result)
            if len(content.encode()) > 12_000:
                artifact_id = self.artifacts.put(content)
                content = dumps({"artifactId": artifact_id, "preview": content[:1500], "truncated": True})
        except asyncio.CancelledError:
            failed = True
            content = dumps(
                {
                    "error": "interrupted_unknown_effect" if dispatched else "cancelled_before_dispatch",
                    "message": "Execution was cancelled. Inspect actual state before repeating writes.",
                }
            )
        except Exception as error:
            failed = True
            content = dumps({"error": error_info(error)["code"], "message": error_info(error)["message"]})
        message: Message = {
            "role": "tool",
            "toolCallId": call["id"],
            "name": call["name"],
            "content": content,
            "isError": bool(failed),
        }
        if execution:
            message["execution"] = execution
        self.emit({"type": "tool_finished", "runId": run_id, "result": copy.deepcopy(message)})
        return message
