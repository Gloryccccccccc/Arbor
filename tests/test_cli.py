import asyncio
import json
import os
import sys
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest


async def invoke(tmp_path, *arguments, env=None):
    environment = {
        k: v for k, v in os.environ.items() if not k.startswith(("ARBOR_", "DASHSCOPE_", "DEEPSEEK_"))
    }
    environment.update({"PYTHONIOENCODING": "utf-8", **(env or {})})
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "arbor",
        *arguments,
        cwd=tmp_path,
        env=environment,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), 20)
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    return process.returncode, stdout.decode(), stderr.decode()


def event(payload):
    return "data: " + json.dumps(payload) + "\n\n"


def complete(output):
    return event(
        {
            "type": "response.completed",
            "response": {
                "status": "completed",
                "output": output,
                "usage": {"input_tokens": 30, "output_tokens": 10},
            },
        }
    )


def final(text="Done."):
    return {
        "type": "message",
        "id": "msg",
        "status": "completed",
        "role": "assistant",
        "content": [{"type": "output_text", "text": text, "annotations": []}],
    }


@contextmanager
def server(callback):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append((self.path, body))
            source = callback(body, len(requests))
            raw = source.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *args):
            pass

    instance = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=instance.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{instance.server_port}/v1", requests
    finally:
        instance.shutdown()
        instance.server_close()
        thread.join(3)


async def test_help_version_and_list_without_credentials(tmp_path):
    code, stdout, _ = await invoke(tmp_path, "--help")
    assert code == 0 and "--read-only" in stdout and "--resume" in stdout
    assert (await invoke(tmp_path, "--version"))[1].strip() == "0.2.0"
    code, stdout, _ = await invoke(tmp_path, "--list")
    assert code == 0 and json.loads(stdout) == []


@pytest.mark.parametrize(
    "provider,variable",
    [("deepseek", "DEEPSEEK_API_KEY"), ("bailian", "DASHSCOPE_API_KEY"), ("responses", "ARBOR_API_KEY")],
)
async def test_missing_key_errors_are_provider_specific(tmp_path, provider, variable):
    code, _, stderr = await invoke(tmp_path, "--provider", provider, "--model", "test", "-p", "hello")
    assert code == 1 and variable in stderr


async def test_local_env_responses_tools_and_resume(tmp_path):
    (tmp_path / "source.txt").write_text("Responses evidence")
    reasoning = {"type": "reasoning", "id": "rs", "summary": [], "encrypted_content": "opaque-fixture"}
    call = {
        "type": "function_call",
        "id": "fc-item",
        "call_id": "read-call",
        "status": "completed",
        "name": "read",
        "arguments": '{"path":"source.txt"}',
    }

    def respond(body, count):
        return complete([reasoning, call] if count == 1 else [final()])

    with server(respond) as (base, requests):
        key = "local-test-secret"
        (tmp_path / ".env.local").write_text(
            f"ARBOR_PROVIDER=responses\nARBOR_MODEL=gpt-6.1-sol\nARBOR_BASE_URL={base}\nARBOR_API_KEY={key}\n"
        )
        code, stdout, stderr = await invoke(tmp_path, "--read-only", "--json", "-p", "Read source.txt")
        assert code == 0, stderr
        events = [json.loads(line) for line in stdout.splitlines()]
        assert events[-1]["result"]["stopReason"] == "model_stop"
        identity = events[0]["sessionId"]
        code, resumed_stdout, resumed_stderr = await invoke(
            tmp_path, "--resume", identity, "--read-only", "-p", "What did you read?"
        )
        assert code == 0, resumed_stderr
        assert len(requests) == 3 and all(path == "/v1/responses" for path, _ in requests)
        for _, body in requests[1:]:
            assert reasoning in body["input"] and call in body["input"]
            result = next(item for item in body["input"] if item.get("type") == "function_call_output")
            assert result["call_id"] == "read-call" and "Responses evidence" in result["output"]
        saved = (tmp_path / ".arbor/sessions" / (identity + ".jsonl")).read_text()
        assert key not in saved + stdout + stderr + resumed_stdout + resumed_stderr
        assert "opaque-fixture" in saved


async def test_compatible_chat_round_trip(tmp_path):
    (tmp_path / "source.txt").write_text("Chat evidence")

    def respond(body, count):
        delta = (
            {
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "r",
                        "type": "function",
                        "function": {"name": "read", "arguments": '{"path":"source.txt"}'},
                    }
                ]
            }
            if count == 1
            else {"content": "Done."}
        )
        return (
            event({"choices": [{"delta": delta, "finish_reason": "tool_calls" if count == 1 else "stop"}]})
            + "data: [DONE]\n\n"
        )

    with server(respond) as (base, requests):
        code, _, stderr = await invoke(
            tmp_path,
            "--provider",
            "compatible",
            "--model",
            "configured-id",
            "--base-url",
            base,
            "--read-only",
            "-p",
            "Read source.txt",
            env={"ARBOR_API_KEY": "test"},
        )
        assert code == 0, stderr
        assert len(requests) == 2 and requests[-1][0] == "/v1/chat/completions"
        assert "Chat evidence" in requests[-1][1]["messages"][-1]["content"]


@pytest.mark.parametrize("trusted", [True, False])
async def test_noninteractive_write_permission(tmp_path, trusted):
    call = {
        "type": "function_call",
        "id": "fc",
        "call_id": "w",
        "status": "completed",
        "name": "write",
        "arguments": '{"path":"created.txt","content":"created"}',
    }
    with server(lambda body, count: complete([call] if count == 1 else [final()])) as (base, requests):
        args = [
            "--provider",
            "responses",
            "--model",
            "configured-id",
            "--base-url",
            base,
            "-p",
            "Write a file",
        ]
        if trusted:
            args.append("--trusted")
        code, _, stderr = await invoke(tmp_path, *args, env={"ARBOR_API_KEY": "test"})
        assert code == 0, stderr
        assert (tmp_path / "created.txt").exists() == trusted
        result = next(i for i in requests[-1][1]["input"] if i.get("type") == "function_call_output")
        assert ("permission_denied" in result["output"]) != trusted


async def test_invalid_json_mode_and_noninteractive_input(tmp_path):
    code, _, stderr = await invoke(tmp_path, "--json")
    assert code == 1 and "requires --prompt" in stderr
    code, _, stderr = await invoke(
        tmp_path,
        "--provider",
        "responses",
        "--model",
        "model",
        "--base-url",
        "https://example.com/v1",
        env={"ARBOR_API_KEY": "test"},
    )
    assert code == 1 and "Use --prompt" in stderr
