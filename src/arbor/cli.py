import argparse
import asyncio
import os
import signal
import sys
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from prompt_toolkit import PromptSession
from prompt_toolkit.patch_stdout import patch_stdout

from . import __version__
from .coding_session import CodingSession, create_coding_session
from .context import dumps
from .errors import ArborError, error_info
from .models import (
    BailianProvider,
    ChatCompletionsProvider,
    DeepSeekProvider,
    HTTPProvider,
    ResponsesProvider,
)
from .session import SessionStore
from .types import ApprovalRequest, Event, RunBudget


def positive(value: str) -> int:
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("Use a positive integer.")
    return number


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        prog="arbor",
        description="A lightweight local coding harness. Local shell execution is not a sandbox.",
    )
    result.add_argument("--version", action="version", version=__version__)
    result.add_argument("--cwd", type=Path, default=Path.cwd(), help="workspace directory")
    result.add_argument("--env-file", type=Path, help="environment file (default: .env.local if present)")
    result.add_argument("--data-dir", type=Path)
    result.add_argument("--resume", help="resume a saved session")
    result.add_argument("--list", action="store_true", help="list sessions without model credentials")
    result.add_argument("-p", "--prompt", help="run one task without interactive input")
    result.add_argument("--json", action="store_true", help="write structured events; requires --prompt")
    permission = result.add_mutually_exclusive_group()
    permission.add_argument(
        "--trusted", action="store_true", help="allow local writes and commands without per-call approval"
    )
    permission.add_argument("--read-only", action="store_true", help="deny writes and shell commands")
    result.add_argument("--provider", choices=["responses", "compatible", "bailian", "deepseek"])
    result.add_argument("--model", help="exact provider model ID")
    result.add_argument("--base-url", help="model API base URL")
    result.add_argument(
        "--thinking", choices=["auto", "on", "off"], default="auto", help="Bailian enable_thinking"
    )
    result.add_argument("--request-timeout", type=positive, default=60, help="seconds per model request")
    result.add_argument("--max-output-tokens", type=positive, default=4096)
    result.add_argument("--max-turns", type=positive, default=20)
    result.add_argument("--max-tool-calls", type=positive, default=50)
    result.add_argument("--max-duration", type=positive, default=300, help="seconds per run")
    result.add_argument("--context-window", type=positive, default=64_000)
    return result


def model_provider(options: argparse.Namespace) -> HTTPProvider:
    name = options.provider or os.environ.get("ARBOR_PROVIDER", "deepseek")
    if name not in {"responses", "compatible", "bailian", "deepseek"}:
        raise ArborError("configuration", "Invalid ARBOR_PROVIDER setting.")
    if options.thinking != "auto" and name != "bailian":
        raise ArborError("configuration", "--thinking is supported only by the bailian adapter.")
    common: dict[str, Any] = {"context_window": options.context_window, "timeout": options.request_timeout}
    model = options.model or os.environ.get("ARBOR_MODEL")
    base_url = options.base_url or os.environ.get("ARBOR_BASE_URL")
    key = os.environ.get("ARBOR_API_KEY")
    if name == "bailian":
        return BailianProvider(
            **common,
            api_key=key or os.environ.get("DASHSCOPE_API_KEY", ""),
            model=model or os.environ.get("DASHSCOPE_MODEL", ""),
            base_url=base_url
            or os.environ.get("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
            enable_thinking=None if options.thinking == "auto" else options.thinking == "on",
        )
    if name == "deepseek":
        return DeepSeekProvider(
            **common,
            api_key=key or os.environ.get("DEEPSEEK_API_KEY", ""),
            model=model or os.environ.get("DEEPSEEK_MODEL", "deepseek-flash"),
            base_url=base_url or os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
        )
    cls = ResponsesProvider if name == "responses" else ChatCompletionsProvider
    return cls(**common, api_key=key or "", model=model or "", base_url=base_url or "")


def show_event(event: Event, interactive: bool) -> None:
    if event["type"] == "text_delta" and interactive:
        print(event["text"], end="", flush=True)
    if event["type"] == "tool_started":
        print("\n[tool] " + event["call"]["name"], file=sys.stderr, flush=True)
    if event["type"] == "tool_finished":
        result = event["result"]
        print(
            f"[{'error' if result['isError'] else 'done'}] {result['name']}"
            + (": " + result["content"][:600] if result["isError"] else ""),
            file=sys.stderr,
            flush=True,
        )
    if event["type"] == "steering_returned":
        print("Corrections not consumed: " + dumps(event["inputs"]), file=sys.stderr)


async def interactive(session_options: dict[str, Any]) -> None:
    prompt: PromptSession[str] = PromptSession()
    decision: asyncio.Future[bool] | None = None

    async def approve(request: ApprovalRequest) -> bool:
        nonlocal decision
        decision = asyncio.get_running_loop().create_future()
        print(f"\nApprove {request.call['name']} {dumps(request.call['arguments'])}? [y/N]", file=sys.stderr)
        try:
            return await decision
        finally:
            decision = None

    session = await create_coding_session(**session_options, approve=approve)
    session.subscribe(lambda e: show_event(e, True))
    print(
        f"Arbor {__version__} · session {session.id}\n/help for commands. Local shell execution is not a sandbox.",
        file=sys.stderr,
    )
    action: asyncio.Task[None] | None = None

    async def perform(text: str) -> None:
        try:
            if text == "/compact":
                report = await session.compact()
                print(f"Compacted {report['summarizedMessages']} messages; kept {report['keptMessages']}.")
            elif text.startswith("/note "):
                await session.note(text[6:])
                print("Note saved.")
            else:
                result = await session.prompt(text)
                print()
                print(
                    f"[{result.stop_reason}] {result.turns} turns, {result.tool_calls} tool calls",
                    file=sys.stderr,
                )
                if result.error:
                    print(result.error["message"], file=sys.stderr)
        except asyncio.CancelledError:
            print("Cancelled.", file=sys.stderr)
        except Exception as error:
            print(error_info(error)["message"], file=sys.stderr)

    try:
        with patch_stdout():
            while True:
                try:
                    text = (await prompt.prompt_async("arbor> ")).strip()
                except EOFError:
                    break
                except KeyboardInterrupt:
                    if session.busy:
                        await session.abort()
                        continue
                    break
                if text == "/exit":
                    break
                if text == "/cancel":
                    await session.abort()
                    continue
                if decision is not None:
                    if not decision.done():
                        decision.set_result(text.lower() in {"y", "yes"})
                    continue
                if not text:
                    continue
                if text == "/help":
                    print(
                        "/help /session /note <constraint> /compact /cancel /exit\nDuring a run, text is queued as a correction."
                    )
                elif text == "/session":
                    print(session.id)
                elif session.busy or action is not None and not action.done():
                    try:
                        session.steer(text)
                    except ArborError as error:
                        print(str(error), file=sys.stderr)
                else:
                    action = asyncio.create_task(perform(text))
    finally:
        if decision is not None and not decision.done():
            decision.set_result(False)
        await session.abort()
        if action:
            await asyncio.gather(action, return_exceptions=True)
        await session.dispose()


async def run(options: argparse.Namespace) -> int:
    env_file = options.env_file or Path(".env.local")
    if options.env_file and not env_file.is_file():
        raise ArborError("configuration", "The selected environment file does not exist.")
    if env_file.is_file():
        load_dotenv(env_file, override=False)
    if options.json and not options.prompt:
        raise ArborError("configuration", "--json requires --prompt.")
    cwd = options.cwd.resolve()
    data_dir = options.data_dir or Path(os.environ.get("ARBOR_DATA_DIR", str(cwd / ".arbor")))
    if options.list:
        print(dumps(SessionStore.list(data_dir)))
        return 0
    provider = model_provider(options)
    try:
        kwargs: dict[str, Any] = {
            "cwd": cwd,
            "provider": provider,
            "data_dir": data_dir,
            "resume": options.resume,
            "permissions": "read-only" if options.read_only else "trusted" if options.trusted else "ask",
            "budget": RunBudget(
                max_turns=options.max_turns,
                max_tool_calls=options.max_tool_calls,
                max_duration_ms=options.max_duration * 1000,
                max_output_tokens=options.max_output_tokens,
            ),
        }
        if options.prompt is None:
            if sys.stdin is None or not sys.stdin.isatty() or sys.stdout is None or not sys.stdout.isatty():
                raise ArborError("configuration", "Use --prompt when stdin is not an interactive terminal.")
            await interactive(kwargs)
            return 0
        session: CodingSession = await create_coding_session(**kwargs)
        loop = asyncio.get_running_loop()
        previous = signal.getsignal(signal.SIGINT)
        signal.signal(
            signal.SIGINT, lambda *_: loop.call_soon_threadsafe(lambda: asyncio.create_task(session.abort()))
        )
        try:
            session.subscribe(lambda e: print(dumps(e), flush=True) if options.json else show_event(e, False))
            result = await session.prompt(options.prompt)
            if not options.json:
                print(result.final_text)
            if result.error:
                print(result.error["message"], file=sys.stderr)
            return (
                0 if result.stop_reason == "model_stop" else 130 if result.stop_reason == "cancelled" else 1
            )
        finally:
            signal.signal(signal.SIGINT, previous)
            await session.dispose()
    finally:
        await provider.aclose()


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    options = parser().parse_args()
    try:
        status = asyncio.run(run(options))
    except KeyboardInterrupt:
        status = 130
    except Exception as error:
        info = error_info(error)
        print(f"Arbor: {info['code']}: {info['message']}", file=sys.stderr)
        status = 1
    raise SystemExit(status)
