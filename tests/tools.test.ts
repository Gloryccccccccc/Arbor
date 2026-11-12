import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/tools/artifacts.js";
import { codingTools, ToolExecutor } from "../src/tools/executor.js";
import { LocalOperations, sha256 } from "../src/tools/local.js";
import { workspace } from "./helpers.js";

async function setup() {
  const cwd = await workspace();
  const dataDir = join(cwd, ".arbor");
  const artifacts = new ArtifactStore(dataDir, "test-session");
  const operations = await LocalOperations.create(cwd, dataDir, artifacts);
  return { cwd, dataDir, artifacts, operations };
}
const signal = () => new AbortController().signal;

describe("workspace text tools", () => {
  it("reads line ranges and requires a current hash for an edit", async () => {
    const { cwd, operations } = await setup();
    await writeFile(join(cwd, "a.ts"), "first\nsecond\nthird\n");
    const found = await operations.read("a.ts", 2, 2, signal()) as { content: string; sha256: string };
    expect(found.content).toBe("second");
    await operations.edit("a.ts", "second", "updated", found.sha256, signal());
    expect(await readFile(join(cwd, "a.ts"), "utf8")).toBe("first\nupdated\nthird\n");
    await expect(operations.edit("a.ts", "third", "wrong", found.sha256, signal())).rejects.toMatchObject({ code: "file_conflict" });
  });
  it("refuses ambiguous edits and overwrites without a baseline", async () => {
    const { cwd, operations } = await setup();
    await writeFile(join(cwd, "a"), "same same");
    await expect(operations.edit("a", "same", "new", sha256("same same"), signal())).rejects.toMatchObject({ code: "edit_match" });
    await expect(operations.write("a", "new", undefined, signal())).rejects.toMatchObject({ code: "file_conflict" });
    expect(await readFile(join(cwd, "a"), "utf8")).toBe("same same");
  });
  it("creates a file under a new directory", async () => {
    const { cwd, operations } = await setup();
    await operations.write("nested/a.ts", "export const a = 1;", undefined, signal());
    expect(await readFile(join(cwd, "nested/a.ts"), "utf8")).toContain("const a");
  });
  it.each(["../outside", ".git/config", ".env", ".arbor/state", "secret.pem"])("refuses protected path %s", async (path) => {
    const { operations } = await setup();
    await expect(operations.write(path, "bad", undefined, signal())).rejects.toMatchObject({ code: "path_denied" });
  });
  it("rejects a directory symlink escaping the workspace", async () => {
    const { cwd, operations } = await setup();
    const outside = await workspace();
    await writeFile(join(outside, "secret"), "not accessible");
    await symlink(outside, join(cwd, "shortcut"), process.platform === "win32" ? "junction" : "dir");
    await expect(operations.read("shortcut/secret", 1, 1, signal())).rejects.toMatchObject({ code: "path_denied" });
  });
  it("stores and reads large output by scoped artifact reference", async () => {
    const { artifacts, operations } = await setup();
    const id = await artifacts.put("first\nsecond\n");
    const result = await operations.read("artifact:" + id, 2, 2, signal()) as { content: string };
    expect(result.content).toBe("second");
    await expect(operations.read("artifact:../../anything", 1, 1, signal())).rejects.toMatchObject({ code: "artifact_id" });
  });
  it("pages long artifact lines without recursively creating unreadable artifacts", async () => {
    const { operations, artifacts } = await setup();
    const source = "中".repeat(5000) + "TAIL";
    const id = await artifacts.put(source);
    const executor = new ToolExecutor({ registry: codingTools(operations), permissions: "read-only", artifacts, emit: () => {}, beforeExecute: async () => {} });
    let offset = 0;
    let restored = "";
    for (let i = 0; i < 10; i++) {
      const result = await executor.execute({ id: String(i), name: "read", arguments: { path: "artifact:" + id, offset } }, { runId: "r", signal: signal() });
      const page = JSON.parse(result.content) as { content: string; nextOffset: number | null; artifactId?: string };
      expect(page.artifactId).toBeUndefined();
      expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(12_000);
      restored += page.content;
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    expect(restored).toBe(source);
  });
});

describe("tool execution boundary", () => {
  it.each(["read-only", "ask"] as const)("does not write when %s permission rejects the call", async (permissions) => {
    const { cwd, operations, artifacts } = await setup();
    let dispatched = 0;
    const executor = new ToolExecutor({ registry: codingTools(operations), permissions, approve: async () => false, artifacts, emit: () => {}, beforeExecute: async () => { dispatched++; } });
    const result = await executor.execute({ id: "1", name: "write", arguments: { path: "a", content: "bad" } }, { runId: "r", signal: signal() });
    expect(result.isError).toBe(true);
    expect(dispatched).toBe(0);
    await expect(readFile(join(cwd, "a"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("validates before approval and dispatch, without type coercion", async () => {
    const { operations, artifacts } = await setup();
    let approvals = 0;
    const executor = new ToolExecutor({ registry: codingTools(operations), permissions: "ask", approve: async () => { approvals++; return true; }, artifacts, emit: () => {}, beforeExecute: async () => { throw new Error("must not dispatch"); } });
    const result = await executor.execute({ id: "1", name: "exec", arguments: { command: "echo test", timeoutMs: "1000" } }, { runId: "r", signal: signal() });
    expect(result.content).toContain("schema_error");
    expect(approvals).toBe(0);
  });
  it("captures nonzero exit codes and strips model credentials from child environments", async () => {
    const { operations } = await setup();
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "should-not-inherit";
    try {
      const result = await operations.exec('node -e "console.log(Boolean(process.env.DEEPSEEK_API_KEY)); process.exit(7)"', 10_000, signal()) as { exitCode: number; stdout: string };
      expect(result.exitCode).toBe(7);
      expect(result.stdout.trim()).toBe("false");
    } finally { if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous; }
  });
  it("decodes Unicode shell output on the current platform", async () => {
    const { operations } = await setup();
    const command = process.platform === "win32" ? "Write-Output '中文反馈'" : "printf '中文反馈'";
    const result = await operations.exec(command, 10_000, signal()) as { stdout: string; exitCode: number };
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("中文反馈");
  });
  it("bounds output while preserving the command tail and an artifact", async () => {
    const { operations, artifacts } = await setup();
    const result = await operations.exec('node -e "process.stdout.write(\'x\'.repeat(20000)+\'TAIL\')"', 10_000, signal()) as { stdout: string; outputTruncated: boolean; artifactId: string };
    expect(result.outputTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(9000);
    expect(result.stdout.endsWith("TAIL")).toBe(true);
    expect((await artifacts.read(result.artifactId)).length).toBe(20004);
  });
  it("terminates a timed out process", async () => {
    const { operations } = await setup();
    const result = await operations.exec('node -e "setInterval(()=>{},1000)"', 300, signal()) as { timedOut: boolean; cleanupError: boolean };
    expect(result.timedOut).toBe(true);
    expect(result.cleanupError).toBe(false);
  });
  it("aborts a running command without waiting for its full duration", async () => {
    const { operations } = await setup();
    const controller = new AbortController();
    const running = operations.exec('node -e "setInterval(()=>{},1000)"', 10_000, controller.signal);
    setTimeout(() => controller.abort(), 250);
    const result = await running as { cancelled: boolean; cleanupError: boolean };
    expect(result.cancelled).toBe(true);
    expect(result.cleanupError).toBe(false);
  });
  it("does not execute an already cancelled file write", async () => {
    const { cwd, operations } = await setup();
    await mkdir(join(cwd, "dir"));
    const controller = new AbortController(); controller.abort();
    await expect(operations.write("dir/a", "bad", undefined, controller.signal)).rejects.toThrow();
    await expect(readFile(join(cwd, "dir/a"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
