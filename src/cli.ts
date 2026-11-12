#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from "commander";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { createCodingSession, type CodingSession } from "./coding-session.js";
import { DeepSeekProvider } from "./model/deepseek.js";
import { BailianProvider } from "./model/bailian.js";
import { ChatCompletionsProvider } from "./model/chat-completions.js";
import { SessionStore } from "./session/store.js";
import { ArborError, errorInfo } from "./errors.js";
import type { ApprovalHandler, HarnessEvent, ModelProvider } from "./types.js";

function positive(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new InvalidArgumentError("Use a positive integer.");
  return number;
}

interface Options {
  cwd: string; dataDir?: string; resume?: string; prompt?: string; json?: boolean; list?: boolean;
  trusted?: boolean; readOnly?: boolean; model?: string; baseUrl?: string; maxTurns: number; maxToolCalls: number;
  provider: "deepseek" | "bailian" | "compatible"; thinking: "auto" | "on" | "off";
  maxDuration: number; contextWindow: number; requestTimeout: number; maxOutputTokens: number;
}

function modelProvider(options: Options): ModelProvider {
  if (options.thinking !== "auto" && options.provider !== "bailian") throw new ArborError("configuration", "--thinking is only supported with --provider bailian; leave auto for other providers.");
  const common = {
    contextWindow: options.contextWindow,
    timeoutMs: options.requestTimeout * 1000,
  };
  const model = options.model ?? process.env.ARBOR_MODEL;
  const baseUrl = options.baseUrl ?? process.env.ARBOR_BASE_URL;
  if (options.provider === "bailian") return new BailianProvider({
    ...common, apiKey: process.env.ARBOR_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? "",
    model: model ?? process.env.DASHSCOPE_MODEL ?? "", baseUrl: baseUrl ?? process.env.DASHSCOPE_BASE_URL,
    enableThinking: options.thinking === "auto" ? undefined : options.thinking === "on",
  });
  if (options.provider === "compatible") return new ChatCompletionsProvider({
    ...common, apiKey: process.env.ARBOR_API_KEY ?? "", model: model ?? "", baseUrl: baseUrl ?? "",
  });
  return new DeepSeekProvider({
    ...common, apiKey: process.env.ARBOR_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "",
    model: model ?? process.env.DEEPSEEK_MODEL, baseUrl: baseUrl ?? process.env.DEEPSEEK_BASE_URL,
  });
}

function showEvent(event: HarnessEvent, interactive: boolean): void {
  if (event.type === "text_delta" && interactive) process.stdout.write(String(event.text));
  if (event.type === "tool_started") process.stderr.write(`\n[tool] ${String((event.call as { name: string }).name)}\n`);
  if (event.type === "tool_finished") {
    const result = event.result as { name: string; isError: boolean; content: string };
    process.stderr.write(`[${result.isError ? "error" : "done"}] ${result.name}${result.isError ? ": " + result.content.slice(0, 600) : ""}\n`);
  }
  if (event.type === "steering_returned") process.stderr.write("\nCorrections not consumed by the cancelled run: " + JSON.stringify(event.inputs) + "\n");
}

async function interactive(sessionFactory: (approve: ApprovalHandler) => Promise<CodingSession>): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "arbor> " });
  let decision: ((allowed: boolean) => void) | undefined;
  let closing = false;
  let action: Promise<unknown> | undefined;
  const approve: ApprovalHandler = async (request) => new Promise<boolean>((resolveApproval) => {
    const finish = (allowed: boolean) => {
      request.signal.removeEventListener("abort", aborted);
      decision = undefined;
      resolveApproval(allowed);
    };
    const aborted = () => finish(false);
    decision = finish;
    request.signal.addEventListener("abort", aborted, { once: true });
    if (request.signal.aborted) return finish(false);
    process.stderr.write(`\nApprove local ${request.call.name} ${JSON.stringify(request.call.arguments)}? [y/N]\n`);
  });
  let session: CodingSession;
  try { session = await sessionFactory(approve); }
  catch (error) { rl.close(); throw error; }
  session.subscribe((event) => showEvent(event, true));
  process.stderr.write(`Arbor 0.1.0 · local execution · session ${session.id}\n/help for commands. Local shell execution is not a sandbox.\n`);
  const exit = async () => {
    if (closing) return;
    closing = true;
    decision?.(false);
    await session.abort();
    await action?.catch(() => undefined);
    await session.dispose();
    rl.close();
  };
  rl.on("SIGINT", () => {
    if (session.busy) { void session.abort().then(() => { process.stderr.write("\nCancellation requested.\n"); rl.prompt(); }); }
    else void exit();
  });
  rl.on("line", (line) => {
    const input = line.trim();
    if (closing) return;
    if (input === "/exit") { void exit(); return; }
    if (input === "/cancel") { void session.abort().then(() => { process.stderr.write("\nStopped.\n"); rl.prompt(); }); return; }
    if (decision) { decision(["y", "yes"].includes(input.toLowerCase())); return; }
    if (!input) { rl.prompt(); return; }
    if (input === "/help") {
      process.stdout.write("/help · /session · /note <constraint> · /compact · /cancel · /exit\nDuring a run, ordinary input is queued as a correction.\n"); rl.prompt(); return;
    }
    if (input === "/session") { process.stdout.write(session.id + "\n"); rl.prompt(); return; }
    if (session.busy) {
      try { session.steer(input); process.stderr.write("\nCorrection queued.\n"); }
      catch (error) { process.stderr.write(errorInfo(error).message + "\n"); }
      return;
    }
    action = (async () => {
      if (input === "/compact") { const report = await session.compact(); process.stdout.write(`\nCompacted ${report.summarizedMessages} messages; kept ${report.keptMessages}.\n`); }
      else if (input.startsWith("/note ")) { await session.note(input.slice(6)); process.stdout.write("Note saved.\n"); }
      else {
        const result = await session.prompt(input);
        process.stdout.write("\n");
        process.stderr.write(`[${result.stopReason}] ${result.turns} turns, ${result.toolCalls} tool calls; verification: ${result.verification}\n`);
        if (result.error) process.stderr.write(result.error.message + "\n");
      }
    })().catch((error: unknown) => { process.stderr.write(errorInfo(error).message + "\n"); }).finally(() => { if (!closing) rl.prompt(); });
  });
  await new Promise<void>((resolveClose) => {
    rl.on("close", () => {
      if (!closing) { closing = true; void session.abort().then(async () => { await action; await session.dispose(); resolveClose(); }); }
      else resolveClose();
    });
    rl.prompt();
  });
}

async function main(): Promise<void> {
  const program = new Command().name("arbor").description("A local coding agent harness. Local execution is not a sandbox.").version("0.1.0")
    .option("--cwd <directory>", "workspace", process.cwd())
    .option("--data-dir <directory>", "session and artifact directory (default: <workspace>/.arbor)")
    .option("--resume <id>", "resume a saved session")
    .option("--list", "list sessions without calling a model")
    .option("-p, --prompt <text>", "run one task without interactive input")
    .option("--json", "write structured events to stdout (requires --prompt)")
    .option("--trusted", "explicitly allow local write/edit/shell without per-call approval")
    .option("--read-only", "deny write/edit/shell tools")
    .addOption(new Option("--provider <name>", "model provider").choices(["deepseek", "bailian", "compatible"]).env("ARBOR_PROVIDER").default("deepseek"))
    .option("--model <name>", "exact model ID (or ARBOR_MODEL / provider-specific environment variable)")
    .option("--base-url <url>", "API base URL (HTTPS, or loopback HTTP)")
    .addOption(new Option("--thinking <mode>", "Bailian enable_thinking; auto keeps the model default").choices(["auto", "on", "off"]).default("auto"))
    .option("--request-timeout <seconds>", "timeout per model request, including its stream", positive, 60)
    .option("--max-output-tokens <tokens>", "maximum output tokens per model turn, including reasoning", positive, 4096)
    .option("--max-turns <number>", "maximum model turns per run", positive, 20)
    .option("--max-tool-calls <number>", "maximum tool calls per run", positive, 50)
    .option("--max-duration <seconds>", "maximum run duration", positive, 300)
    .option("--context-window <tokens>", "conservative configured context window", positive, 64_000);
  program.parse();
  const options = program.opts<Options>();
  if (options.trusted && options.readOnly) throw new ArborError("configuration", "Choose either --trusted or --read-only.");
  if (options.json && !options.prompt) throw new ArborError("configuration", "--json requires --prompt.");
  const cwd = resolve(options.cwd);
  const dataDir = resolve(options.dataDir ?? process.env.ARBOR_DATA_DIR ?? resolve(cwd, ".arbor"));
  if (options.list) {
    process.stdout.write(JSON.stringify(await SessionStore.list(dataDir), null, 2) + "\n");
    return;
  }
  const provider = modelProvider(options);
  const factory = (approve?: ApprovalHandler) => createCodingSession({
    cwd, dataDir, provider, resume: options.resume,
    permissions: options.readOnly ? "read-only" : options.trusted ? "trusted" : "ask", approve,
    budget: { maxTurns: options.maxTurns, maxToolCalls: options.maxToolCalls, maxDurationMs: options.maxDuration * 1000, maxOutputTokens: options.maxOutputTokens },
  });
  if (!options.prompt) {
    if (!process.stdin.isTTY) throw new ArborError("configuration", "Use --prompt when stdin is not an interactive terminal.");
    await interactive(factory);
    return;
  }
  const session = await factory();
  const cancel = () => { void session.abort(); };
  process.on("SIGINT", cancel);
  try {
    session.subscribe((event) => options.json ? process.stdout.write(JSON.stringify(event) + "\n") : showEvent(event, false));
    const result = await session.prompt(options.prompt);
    if (!options.json) process.stdout.write(result.finalText + "\n");
    if (result.error) process.stderr.write(result.error.message + "\n");
    process.exitCode = result.stopReason === "model_stop" ? 0 : result.stopReason === "cancelled" ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    await session.dispose();
  }
}

main().catch((error: unknown) => {
  const info = errorInfo(error);
  process.stderr.write(`Arbor: ${info.code}: ${info.message}\n`);
  process.exitCode = 1;
});
