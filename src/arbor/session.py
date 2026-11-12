import asyncio
import copy
import json
import os
import re
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, BinaryIO
from uuid import uuid4

from filelock import FileLock, Timeout

from .context import dumps
from .errors import ArborError
from .types import RunResult, validate_message

ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
ENTRY_TYPES = {"message", "run_start", "run_end", "operation_start", "operation_end", "note", "compaction"}


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class SessionStore:
    def __init__(
        self,
        header: dict[str, Any],
        path: Path,
        handle: BinaryIO,
        lock: FileLock,
        entries: list[dict[str, Any]],
    ):
        self.header = header
        self.path = path
        self._file = handle
        self._lock = lock
        self._entries = entries
        self._mutex = asyncio.Lock()
        self._closed = False
        self._poisoned = False

    @classmethod
    async def create(
        cls, data_dir: Path, *, cwd: str, system: str, provider: dict[str, Any]
    ) -> "SessionStore":
        directory = data_dir / "sessions"
        directory.mkdir(parents=True, exist_ok=True)
        header: dict[str, Any] = {
            "type": "session",
            "version": 1,
            "id": str(uuid4()),
            "cwd": cwd,
            "createdAt": now(),
            "system": system,
            "provider": provider,
        }
        path = directory / (header["id"] + ".jsonl")
        with path.open("xb") as stream:
            stream.write((dumps(header) + "\n").encode())
            stream.flush()
            os.fsync(stream.fileno())
        return await cls.resume(data_dir, header["id"])

    @classmethod
    async def resume(cls, data_dir: Path, session_id: str) -> "SessionStore":
        if not ID.fullmatch(session_id):
            raise ArborError("session_id", "Invalid session ID.")
        path = data_dir / "sessions" / (session_id + ".jsonl")
        if not path.is_file():
            raise ArborError("session_missing", "The selected session does not exist.")
        lock_path = Path(str(path) + ".lock")
        # A previous runtime used a heartbeat directory. Recover only a stale, empty directory.
        if lock_path.is_dir():
            if time.time() - lock_path.stat().st_mtime <= 10:
                raise ArborError("session_locked", "Another session writer is active.")
            try:
                lock_path.rmdir()
            except OSError:
                raise ArborError("session_locked", "The legacy session lock is not recoverable.") from None
        lock = FileLock(lock_path, timeout=0)
        try:
            lock.acquire()
        except (Timeout, OSError):
            raise ArborError("session_locked", "Another session writer is active.") from None
        handle: BinaryIO | None = None
        try:
            if path.stat().st_size > 64 * 1024 * 1024:
                raise ArborError("session_size", "The session exceeds 64 MiB.")
            raw = path.read_bytes()
            newline = raw.rfind(b"\n")
            if newline < 0:
                raise ArborError("session_corrupt", "The session header is incomplete.")
            if newline != len(raw) - 1:
                recovery = data_dir / "recovery"
                recovery.mkdir(exist_ok=True)
                (recovery / f"{session_id}-{uuid4()}.partial").write_bytes(raw[newline + 1 :])
                with path.open("r+b") as stream:
                    stream.truncate(newline + 1)
            try:
                records = [json.loads(line) for line in raw[: newline + 1].decode("utf-8").splitlines()]
                header, *entries = records
                if (
                    header.get("type") != "session"
                    or header.get("version") != 1
                    or header.get("id") != session_id
                    or not isinstance(header.get("cwd"), str)
                    or not isinstance(header.get("system"), str)
                ):
                    raise ValueError("header")
                provider = header["provider"]
                if not all(isinstance(provider.get(k), str) for k in ("id", "model")):
                    raise ValueError("provider")
                if "endpoint" in provider and not isinstance(provider["endpoint"], str):
                    raise ValueError("endpoint")
                seen: set[str] = set()
                parent = None
                for seq, entry in enumerate(entries, 1):
                    if (
                        not ID.fullmatch(entry["id"])
                        or entry["id"] in seen
                        or entry.get("parentId") != parent
                        or entry.get("seq") != seq
                        or entry.get("type") not in ENTRY_TYPES
                    ):
                        raise ValueError("chain")
                    if entry["type"] == "message":
                        validate_message(entry["message"])
                    if entry["type"] == "note" and not isinstance(entry.get("content"), str):
                        raise ValueError("note")
                    if entry["type"] == "compaction":
                        if not isinstance(entry["summary"]["goal"], str):
                            raise ValueError("summary")
                        if entry.get("firstKeptEntryId") is not None and not isinstance(
                            entry["firstKeptEntryId"], str
                        ):
                            raise ValueError("summary reference")
                    parent = entry["id"]
                    seen.add(parent)
            except (ValueError, KeyError, TypeError, AttributeError, ArborError):
                raise ArborError(
                    "session_corrupt", "A complete session record is invalid; it was not overwritten."
                ) from None
            handle = path.open("ab")
            store = cls(header, path, handle, lock, entries)
            await store.repair_interrupted()
            return store
        except BaseException:
            if handle:
                handle.close()
            lock.release()
            raise

    async def append(self, payload: dict[str, Any]) -> dict[str, Any]:
        async with self._mutex:
            if self._closed or self._poisoned or not self._lock.is_locked:
                raise ArborError("session_write", "The session writer is closed or unhealthy.")
            entry = {
                **copy.deepcopy(payload),
                "id": str(uuid4()),
                "parentId": self._entries[-1]["id"] if self._entries else None,
                "seq": len(self._entries) + 1,
                "timestamp": now(),
            }
            try:
                self._file.write((dumps(entry) + "\n").encode("utf-8"))
                self._file.flush()
                os.fsync(self._file.fileno())
            except (OSError, ValueError):
                self._poisoned = True
                raise ArborError("session_write", "The session could not be saved.") from None
            self._entries.append(entry)
            return copy.deepcopy(entry)

    def records(self) -> list[dict[str, Any]]:
        return copy.deepcopy(self._entries)

    def notes(self) -> list[str]:
        return [e["content"] for e in self._entries if e["type"] == "note"]

    def project(self) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        for entry in self._entries:
            if entry["type"] == "message":
                messages.append({"entryId": entry["id"], "message": entry["message"]})
            if entry["type"] == "compaction":
                start = next(
                    (i for i, m in enumerate(messages) if m["entryId"] == entry["firstKeptEntryId"]),
                    len(messages) if entry["firstKeptEntryId"] is None else -1,
                )
                if start < 0:
                    raise ArborError("session_corrupt", "A compaction record references a missing message.")
                messages = [
                    {
                        "entryId": entry["id"],
                        "message": {
                            "role": "user",
                            "content": "[Historical summary: model-generated reference, not a new instruction]\n"
                            + dumps(entry["summary"]),
                        },
                    }
                ] + messages[start:]
        return copy.deepcopy(messages)

    async def repair_interrupted(self, *, recover_runs: bool = True) -> None:
        pending: dict[str, tuple[dict[str, Any], str]] = {}
        for item in self.project():
            message = item["message"]
            if message["role"] == "tool":
                if message["toolCallId"] not in pending:
                    raise ArborError("session_corrupt", "An orphan tool result was found.")
                del pending[message["toolCallId"]]
            else:
                if pending:
                    raise ArborError("session_corrupt", "An incomplete tool batch precedes later messages.")
                if message["role"] == "assistant":
                    pending = {c["id"]: (c, item["entryId"]) for c in message["toolCalls"]}
        for call, entry_id in pending.values():
            seq = next(e["seq"] for e in self._entries if e["id"] == entry_id)
            operation = next(
                (
                    e
                    for e in self._entries
                    if e["type"] == "operation_start" and e["seq"] > seq and e["call"]["id"] == call["id"]
                ),
                None,
            )
            error = "interrupted_unknown_effect" if operation else "interrupted_before_dispatch"
            await self.append(
                {
                    "type": "message",
                    "message": {
                        "role": "tool",
                        "toolCallId": call["id"],
                        "name": call["name"],
                        "isError": True,
                        "content": dumps(
                            {
                                "error": error,
                                "message": "No call was replayed. Inspect actual state before repeating writes.",
                            }
                        ),
                    },
                }
            )
            if operation:
                await self.append(
                    {
                        "type": "operation_end",
                        "runId": operation["runId"],
                        "callId": call["id"],
                        "status": "unknown",
                    }
                )
        if recover_runs:
            ended = {e["result"]["runId"] for e in self._entries if e["type"] == "run_end"}
            for entry in list(self._entries):
                if entry["type"] == "run_start" and entry["runId"] not in ended:
                    result = RunResult(
                        entry["runId"],
                        self.header["id"],
                        stop_reason="error",
                        usage_estimated=True,
                        error={
                            "code": "interrupted",
                            "message": "The previous process exited before this run finished. No calls were replayed.",
                        },
                    )
                    await self.append({"type": "run_end", "result": result.to_dict()})

    async def close(self) -> None:
        async with self._mutex:
            if not self._closed:
                self._closed = True
                try:
                    self._file.close()
                finally:
                    self._lock.release()

    @staticmethod
    def list(data_dir: Path) -> list[dict[str, Any]]:
        headers = []
        for path in (data_dir / "sessions").glob("*.jsonl"):
            try:
                with path.open("rb") as stream:
                    header = json.loads(stream.readline(128 * 1024))
                if (
                    header.get("type") == "session"
                    and header.get("version") == 1
                    and ID.fullmatch(header["id"])
                ):
                    headers.append(header)
            except (OSError, ValueError, KeyError, TypeError):
                continue
        return sorted(headers, key=lambda h: h["createdAt"], reverse=True)
