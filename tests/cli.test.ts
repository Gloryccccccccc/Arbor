import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { workspace } from "./helpers.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
function invoke(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", cli, ...args], {
      cwd: root, env: { ...process.env, ARBOR_PROVIDER: "deepseek", ARBOR_API_KEY: undefined, ARBOR_MODEL: undefined, ARBOR_BASE_URL: undefined, DASHSCOPE_API_KEY: undefined, DASHSCOPE_MODEL: undefined, DASHSCOPE_BASE_URL: undefined, DEEPSEEK_MODEL: undefined, DEEPSEEK_BASE_URL: undefined, DEEPSEEK_API_KEY: "", ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolveExit({ code, stdout, stderr }));
  });
}
function sse(response: ServerResponse, content: string, calls?: unknown[]): void {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write("data: " + JSON.stringify({ choices: [{ delta: { content, ...(calls ? { tool_calls: calls } : {}) }, finish_reason: calls ? "tool_calls" : "stop" }] }) + "\n\n");
  response.write("data: " + JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10 } }) + "\n\n");
  response.end("data: [DONE]\n\n");
}
async function body(request: IncomingMessage): Promise<{ messages: Record<string, unknown>[] }> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString()) as { messages: Record<string, unknown>[] };
}

describe("CLI", () => {
  it("requires an explicit Bailian model and reports the right credential variable", async () => {
    const cwd = await workspace();
    const missingKey = await invoke(["--cwd", cwd, "--provider", "bailian", "--model", "kimi-k3", "-p", "hello"]);
    expect(missingKey.code).toBe(1);
    expect(missingKey.stderr).toContain("DASHSCOPE_API_KEY");
    const missingModel = await invoke(["--cwd", cwd, "--provider", "bailian", "-p", "hello"], { DASHSCOPE_API_KEY: "test" });
    expect(missingModel.code).toBe(1);
    expect(missingModel.stderr).toContain("exact model ID");
  });

  it("round-trips Bailian reasoning through real tools, persistence and a resumed CLI process", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "source.txt"), "bailian evidence");
    const inputs: (Record<string, unknown> & { messages: Record<string, unknown>[] })[] = [];
    const paths: string[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        paths.push(request.url!);
        inputs.push(await body(request));
        if (inputs.length === 1) {
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.write("data: " + JSON.stringify({ choices: [{ delta: { reasoning_content: "Inspect before answering." } }] }) + "\n\n");
          response.write("data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "r", function: { name: "read", arguments: '{"path":"source.txt"}' } }] }, finish_reason: "tool_calls" }] }) + "\n\n");
          response.end("data: [DONE]\n\n");
        } else sse(response, "Done.");
      })().catch(() => { response.writeHead(500); response.end(); });
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const env = { ARBOR_PROVIDER: "bailian", DASHSCOPE_API_KEY: "bailian-local-test-key", DASHSCOPE_MODEL: "kimi-k3", DASHSCOPE_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/compatible-mode/v1` };
      const first = await invoke(["--cwd", cwd, "--read-only", "--json", "-p", "Read source.txt"], env);
      expect(first.code, first.stderr).toBe(0);
      const id = String(JSON.parse(first.stdout.trim().split("\n")[0]!).sessionId);
      const resumed = await invoke(["--cwd", cwd, "--resume", id, "--read-only", "-p", "What did you inspect?"], env);
      expect(resumed.code, resumed.stderr).toBe(0);
      expect(inputs).toHaveLength(3);
      expect(paths).toEqual(Array(3).fill("/compatible-mode/v1/chat/completions"));
      for (const input of inputs) {
        expect(input.model).toBe("kimi-k3");
        expect(input).not.toHaveProperty("thinking");
        expect(input).not.toHaveProperty("enable_thinking");
      }
      for (const input of inputs.slice(1)) {
        expect(input.messages.find((m) => m.role === "assistant" && m.tool_calls)).toMatchObject({ reasoning_content: "Inspect before answering." });
        expect(input.messages.find((m) => m.role === "tool")?.content).toContain("bailian evidence");
      }
      const saved = await readFile(join(cwd, ".arbor/sessions", id + ".jsonl"), "utf8");
      expect(JSON.parse(saved.split("\n")[0]!).provider).toEqual({ id: "bailian", model: "kimi-k3" });
      expect(saved).toContain('"reasoningContent":"Inspect before answering."');
      expect(saved + first.stdout + first.stderr + resumed.stdout + resumed.stderr).not.toContain(env.DASHSCOPE_API_KEY);
    } finally { await new Promise<void>((r) => server.close(() => r())); }
  });

  it("shows help and lists sessions without model credentials", async () => {
    const cwd = await workspace();
    const help = await invoke(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--read-only");
    expect(help.stdout).toContain("--resume");
    const list = await invoke(["--cwd", cwd, "--list"]);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual([]);
  });

  it("fails clearly when credentials are absent", async () => {
    const cwd = await workspace();
    const result = await invoke(["--cwd", cwd, "-p", "hello"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("DEEPSEEK_API_KEY");
  });

  it("streams JSON events through a real local HTTP model and persists the session", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "source.txt"), "workspace evidence");
    let requests = 0;
    let observation = "";
    const server = createServer((request, response) => {
      void (async () => {
        const input = await body(request);
        requests++;
        if (requests === 1) sse(response, "Inspect", [{ index: 0, id: "read-1", type: "function", function: { name: "read", arguments: '{"path":"source.txt"}' } }]);
        else { observation = String(input.messages.at(-1)?.content); sse(response, "Read completed."); }
      })().catch(() => { response.writeHead(500); response.end(); });
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const result = await invoke(["--cwd", cwd, "--base-url", url, "--read-only", "--json", "-p", "Read source.txt"], { DEEPSEEK_API_KEY: "local-test-secret" });
      expect(result.code).toBe(0);
      const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events.some((e) => e.type === "tool_finished")).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "run_finished", result: { finalText: "Read completed.", stopReason: "model_stop" } });
      expect(observation).toContain("workspace evidence");
      expect(requests).toBe(2);
      expect(result.stdout + result.stderr).not.toContain("local-test-secret");
      const id = String(events[0]?.sessionId);
      const saved = await readFile(join(cwd, ".arbor/sessions", id + ".jsonl"), "utf8");
      expect(saved).toContain('"type":"run_end"');
      expect(saved).not.toContain("local-test-secret");
      const listed = await invoke(["--cwd", cwd, "--list"]);
      expect(JSON.parse(listed.stdout)[0].id).toBe(id);
    } finally { await new Promise<void>((r) => server.close(() => r())); }
  });

  it("denies non-interactive writes without explicit trusted mode", async () => {
    const cwd = await workspace();
    let count = 0;
    let resultContent = "";
    const server = createServer((request, response) => {
      void (async () => {
        const input = await body(request);
        if (++count === 1) sse(response, "", [{ index: 0, id: "w", type: "function", function: { name: "write", arguments: '{"path":"blocked.txt","content":"no"}' } }]);
        else { resultContent = String(input.messages.at(-1)?.content); sse(response, "Approval is required."); }
      })().catch(() => { response.writeHead(500); response.end(); });
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const result = await invoke(["--cwd", cwd, "--base-url", url, "-p", "write"], { DEEPSEEK_API_KEY: "test" });
      expect(result.code).toBe(0);
      expect(resultContent).toContain("permission_denied");
      await expect(readFile(join(cwd, "blocked.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await new Promise<void>((r) => server.close(() => r())); }
  });
});
