import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCodingSession } from "../src/coding-session.js";
import { ToolRegistry } from "../src/tools/executor.js";
import { abortable } from "../src/errors.js";
import type { ModelProvider, ToolMessage } from "../src/types.js";
import { FakeProvider, reply, summary, workspace } from "./helpers.js";

describe("coding runtime", () => {
  it("runs the read/check/edit/check loop against a real repository fixture", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "timeout.mjs"), "export function timeout(options) { return options.timeout || 1000; }\n");
    await writeFile(join(cwd, "timeout.test.mjs"), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { timeout } from './timeout.mjs';\ntest('zero is a valid timeout', () => assert.equal(timeout({timeout: 0}), 0));\n");
    const provider = new FakeProvider([
      reply("Inspect", [{ id: "read", name: "read", arguments: { path: "timeout.mjs" } }]),
      reply("Check baseline", [{ id: "baseline", name: "exec", arguments: { command: "node --test timeout.test.mjs" } }]),
      (request) => {
        const read = request.messages.find((m) => m.role === "tool" && m.name === "read")!;
        const baseline = request.messages.at(-1)! as ToolMessage;
        expect(baseline.isError).toBe(true);
        expect(JSON.parse(baseline.content).exitCode).not.toBe(0);
        const hash = JSON.parse(read.content).sha256 as string;
        return reply("Fix", [{ id: "edit", name: "edit", arguments: { path: "timeout.mjs", oldText: "options.timeout || 1000", newText: "options.timeout ?? 1000", expectedHash: hash } }]);
      },
      reply("Verify", [{ id: "verify", name: "exec", arguments: { command: "node --test timeout.test.mjs" } }]),
      (request) => {
        const checked = request.messages.at(-1)! as ToolMessage;
        expect(checked.isError).toBe(false);
        expect(JSON.parse(checked.content).exitCode).toBe(0);
        return reply("The test now passes.");
      },
    ]);
    const session = await createCodingSession({ cwd, provider, permissions: "trusted" });
    try {
      const events: string[] = [];
      session.subscribe((e) => events.push(e.type));
      const result = await session.prompt("Fix the failing timeout test, preserving zero.");
      expect(result).toMatchObject({ stopReason: "model_stop", toolCalls: 4, turns: 5, verification: "not_requested" });
      expect(result.finalText).toContain("passes");
      expect(await readFile(join(cwd, "timeout.mjs"), "utf8")).toContain("??");
      expect(events).toContain("tool_finished");
      expect(events.filter((event) => event === "turn_finished")).toHaveLength(result.turns);
      const records = session.store.records();
      expect(records.filter((e) => e.type === "operation_start")).toHaveLength(4);
      expect(records.filter((e) => e.type === "operation_end")).toHaveLength(4);
    } finally { await session.dispose(); }
  });

  it("persists the complete model call and intent before real execution", async () => {
    const cwd = await workspace();
    const registry = new ToolRegistry();
    let sessionPath = "";
    registry.register({ name: "probe", description: "probe", effect: "read", parameters: { type: "object", additionalProperties: false }, execute: async () => {
      const saved = await readFile(sessionPath, "utf8");
      expect(saved).toContain('"type":"operation_start"');
      expect(saved).toContain('"toolCalls":[{"id":"probe-1"');
      return "ok";
    } });
    const provider = new FakeProvider([reply("", [{ id: "probe-1", name: "probe", arguments: {} }]), reply("done")]);
    const session = await createCodingSession({ cwd, provider, registry });
    sessionPath = session.store.path;
    try { expect((await session.prompt("probe")).stopReason).toBe("model_stop"); }
    finally { await session.dispose(); }
  });

  it("never runs a partially streamed call", async () => {
    const cwd = await workspace();
    let executed = 0;
    const registry = new ToolRegistry();
    registry.register({ name: "probe", description: "probe", effect: "read", parameters: { type: "object" }, execute: async () => { executed++; } });
    const provider: ModelProvider = { id: "broken", model: "broken", contextWindow: 64_000, async *stream() {
      yield { type: "tool_delta", index: 0, argumentsDelta: "{}" };
      throw new Error("Connection dropped");
    } };
    const session = await createCodingSession({ cwd, provider, registry });
    try {
      const result = await session.prompt("probe");
      expect(result.stopReason).toBe("error");
      expect(result.usageEstimated).toBe(true);
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(executed).toBe(0);
      expect(session.store.project()).toHaveLength(1);
    } finally { await session.dispose(); }
  });

  it("fills unexecuted calls when the tool budget is exhausted", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a"), "ok");
    const provider = new FakeProvider([reply("", [
      { id: "1", name: "read", arguments: { path: "a" } },
      { id: "2", name: "write", arguments: { path: "b", content: "must not happen" } },
    ])]);
    const session = await createCodingSession({ cwd, provider, permissions: "trusted", budget: { maxToolCalls: 1 } });
    try {
      const result = await session.prompt("read and write");
      expect(result.stopReason).toBe("budget");
      const tools = session.store.project().filter((m) => m.message.role === "tool");
      expect(tools).toHaveLength(2);
      expect(tools[1]?.message.content).toContain("not executed");
      await expect(readFile(join(cwd, "b"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await session.dispose(); }
  });

  it("does not allow duplicate live runs and accepts steering only at a safe boundary", async () => {
    const cwd = await workspace();
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((r) => { started = r; });
    const paused = new Promise<void>((r) => { release = r; });
    const provider = new FakeProvider([
      async () => { started(); await paused; return reply("First response"); },
      (request) => { expect(request.messages.at(-1)?.content).toBe("Correction"); return reply("Corrected"); },
    ]);
    const session = await createCodingSession({ cwd, provider });
    try {
      const running = session.prompt("Start");
      await entered;
      await expect(session.prompt("Concurrent")).rejects.toMatchObject({ code: "session_busy" });
      session.steer("Correction");
      release();
      expect((await running).finalText).toBe("Corrected");
    } finally { await session.dispose(); }
  });

  it("cancels a model wait and leaves the session available for another prompt", async () => {
    const cwd = await workspace();
    let started!: () => void;
    const entered = new Promise<void>((r) => { started = r; });
    const provider = new FakeProvider([
      async (_request, signal) => { started(); await abortable(new Promise<void>(() => {}), signal); return reply("unreachable"); },
      reply("After cancellation"),
    ]);
    const session = await createCodingSession({ cwd, provider });
    try {
      const running = session.prompt("Wait"); await entered;
      await session.abort();
      expect((await running).stopReason).toBe("cancelled");
      expect((await session.prompt("Continue")).finalText).toBe("After cancellation");
    } finally { await session.dispose(); }
  });

  it("returns a structured unknown-tool observation instead of inventing a result", async () => {
    const cwd = await workspace();
    const provider = new FakeProvider([
      reply("", [{ id: "x", name: "not_registered", arguments: {} }]),
      (request) => { expect(request.messages.at(-1)?.content).toContain("unknown_tool"); return reply("Cannot use that tool"); },
    ]);
    const session = await createCodingSession({ cwd, provider });
    try { expect((await session.prompt("try")).stopReason).toBe("model_stop"); }
    finally { await session.dispose(); }
  });
});

describe("manual context compaction", () => {
  async function buildHistory(session: Awaited<ReturnType<typeof createCodingSession>>) {
    for (const content of ["one", "two", "three", "four"]) await session.prompt(content);
  }
  it("keeps original records, a complete recent tool group and pinned constraints", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a"), "source");
    const provider = new FakeProvider([
      reply("A"), reply("B"), reply("C"),
      reply("", [{ id: "r", name: "read", arguments: { path: "a" } }]), reply("D"),
      (request) => { expect(request.tools).toEqual([]); return reply(summary); },
      (request) => { expect(request.system).toContain("Never remove the async interface"); return reply("Continued"); },
    ]);
    const session = await createCodingSession({ cwd, provider });
    try {
      await session.note("Never remove the async interface");
      await buildHistory(session);
      const before = await readFile(session.store.path, "utf8");
      const report = await session.compact(2);
      expect(report.keptMessages).toBe(3);
      const projected = session.store.project();
      expect(projected[0]?.message.content).toContain("Historical summary");
      expect(projected[1]?.message.role).toBe("assistant");
      expect(projected[2]?.message.role).toBe("tool");
      const after = await readFile(session.store.path, "utf8");
      expect(after.startsWith(before)).toBe(true);
      expect(after).toContain('"type":"compaction"');
      expect((await session.prompt("Continue")).finalText).toBe("Continued");
    } finally { await session.dispose(); }
  });

  it("does not change the projected history when a summary is invalid", async () => {
    const cwd = await workspace();
    const provider = new FakeProvider([reply("A"), reply("B"), reply("C"), reply("D"), reply('{"goal":"missing fields"}')]);
    const session = await createCodingSession({ cwd, provider });
    try {
      await buildHistory(session);
      const before = session.store.project();
      await expect(session.compact(2)).rejects.toMatchObject({ code: "summary_invalid" });
      expect(session.store.project()).toEqual(before);
      expect(session.busy).toBe(false);
    } finally { await session.dispose(); }
  });

  it("resumes the compacted view without dropping the raw history", async () => {
    const cwd = await workspace();
    const provider = new FakeProvider([reply("A"), reply("B"), reply("C"), reply("D"), reply(summary), reply("resumed")]);
    const session = await createCodingSession({ cwd, provider });
    let id: string;
    try { await buildHistory(session); await session.compact(2); id = session.id; }
    finally { await session.dispose(); }
    const resumed = await createCodingSession({ cwd, provider, resume: id! });
    try {
      expect(resumed.store.project()[0]?.message.content).toContain("Historical summary");
      expect((await resumed.prompt("Continue")).finalText).toBe("resumed");
    } finally { await resumed.dispose(); }
  });

  it("cancels compaction before disposing the writer", async () => {
    const cwd = await workspace();
    let entered!: () => void;
    const start = new Promise<void>((r) => { entered = r; });
    const provider = new FakeProvider([reply("A"), reply("B"), reply("C"), reply("D"), async (_request, signal) => {
      entered(); await abortable(new Promise<void>(() => {}), signal); return reply(summary);
    }]);
    const session = await createCodingSession({ cwd, provider });
    await buildHistory(session);
    const compacted = session.compact(2);
    const rejected = expect(compacted).rejects.toThrow();
    await start;
    await session.dispose();
    await rejected;
    expect(session.store.records().some((e) => e.type === "compaction")).toBe(false);
  });
});
