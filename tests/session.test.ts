import { appendFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/session/store.js";
import { workspace, reply } from "./helpers.js";

async function create() {
  const cwd = await workspace();
  const dataDir = join(cwd, ".arbor");
  const store = await SessionStore.create(dataDir, { cwd, system: "Rules", provider: { id: "fake", model: "test" } });
  return { cwd, dataDir, store };
}

describe("append-only session persistence", () => {
  it("saves each response before returning and resumes with notes", async () => {
    const { store, dataDir } = await create();
    const id = store.header.id;
    await store.append({ type: "message", message: { role: "user", content: "Keep this goal" } });
    await store.append({ type: "message", message: reply("Recorded") });
    await store.append({ type: "note", content: "Keep the async interface" });
    expect(await readFile(store.path, "utf8")).toContain("Recorded");
    await store.close();
    const resumed = await SessionStore.resume(dataDir, id);
    try {
      expect(resumed.project().map((m) => m.message.content)).toEqual(["Keep this goal", "Recorded"]);
      expect(resumed.notes()).toEqual(["Keep the async interface"]);
    } finally { await resumed.close(); }
  });

  it("rejects a second live writer", async () => {
    const { store, dataDir } = await create();
    try { await expect(SessionStore.resume(dataDir, store.header.id)).rejects.toMatchObject({ code: "session_locked" }); }
    finally { await store.close(); }
  });

  it("backs up a truncated trailing record while preserving completed entries", async () => {
    const { store, dataDir } = await create();
    const path = store.path;
    const id = store.header.id;
    await store.append({ type: "message", message: { role: "user", content: "durable" } });
    await store.close();
    await appendFile(path, '{"incomplete":');
    const resumed = await SessionStore.resume(dataDir, id);
    try {
      expect(resumed.project()[0]?.message.content).toBe("durable");
      expect((await readdir(join(dataDir, "recovery"))).length).toBe(1);
      expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
    } finally { await resumed.close(); }
  });

  it("does not overwrite corruption in a complete record", async () => {
    const { store, dataDir } = await create();
    const { path, header } = store;
    await store.close();
    await appendFile(path, "{invalid}\n");
    await expect(SessionStore.resume(dataDir, header.id)).rejects.toMatchObject({ code: "session_corrupt" });
    expect(await readFile(path, "utf8")).toContain("{invalid}");
  });

  it("marks an interrupted operation unknown without replaying it", async () => {
    const { store, dataDir } = await create();
    const runId = randomUUID();
    const call = { id: "write-1", name: "write", arguments: { path: "a", content: "data" } };
    await store.append({ type: "run_start", runId });
    await store.append({ type: "message", message: { role: "user", content: "write" } });
    await store.append({ type: "message", message: reply("", [call]) });
    await store.append({ type: "operation_start", runId, call });
    const id = store.header.id;
    await store.close();
    const resumed = await SessionStore.resume(dataDir, id);
    try {
      const messages = resumed.project();
      expect(messages.at(-1)?.message).toMatchObject({ role: "tool", isError: true, toolCallId: "write-1" });
      expect(messages.at(-1)?.message.content).toContain("interrupted_unknown_effect");
      expect(resumed.records().some((e) => e.type === "operation_end" && e.status === "unknown")).toBe(true);
      expect(resumed.records().filter((e) => e.type === "operation_start")).toHaveLength(1);
    } finally { await resumed.close(); }
  });

  it("distinguishes a saved call that was never dispatched", async () => {
    const { store, dataDir } = await create();
    await store.append({ type: "message", message: reply("", [{ id: "call", name: "read", arguments: { path: "a" } }]) });
    const id = store.header.id;
    await store.close();
    const resumed = await SessionStore.resume(dataDir, id);
    try { expect(resumed.project().at(-1)?.message.content).toContain("interrupted_before_dispatch"); }
    finally { await resumed.close(); }
  });

  it("lists sessions without needing a model or opening a writer", async () => {
    const { store, dataDir } = await create();
    try { expect((await SessionStore.list(dataDir))[0]?.id).toBe(store.header.id); }
    finally { await store.close(); }
    expect(await SessionStore.list(join(dataDir, "missing"))).toEqual([]);
  });
});
