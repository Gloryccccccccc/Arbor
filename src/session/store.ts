import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, stat, truncate, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { ArborError } from "../errors.js";
import type { Message, RunResult, Summary, ToolCall, Usage } from "../types.js";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface SessionHeader {
  type: "session";
  version: 1;
  id: string;
  cwd: string;
  createdAt: string;
  system: string;
  provider: { id: string; model: string; endpoint?: string };
}
interface Base { id: string; parentId: string | null; seq: number; timestamp: string }
type Payload =
  | { type: "message"; message: Message }
  | { type: "run_start"; runId: string }
  | { type: "run_end"; result: RunResult }
  | { type: "operation_start"; runId: string; call: ToolCall }
  | { type: "operation_end"; runId: string; callId: string; status: "success" | "failed" | "unknown" }
  | { type: "note"; content: string }
  | { type: "compaction"; summary: Summary; firstKeptEntryId: string | null; usage?: Usage };
export type SessionEntry = Base & Payload;
export interface ProjectedMessage { entryId: string; message: Message }

function validMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  if (typeof m.content !== "string") return false;
  if (m.role === "user") return true;
  if (m.role === "tool") return typeof m.toolCallId === "string" && typeof m.name === "string" && typeof m.isError === "boolean";
  const state = m.providerState as { protocol?: unknown; output?: unknown } | undefined;
  return m.role === "assistant" && (m.reasoningContent === undefined || typeof m.reasoningContent === "string") && (state === undefined || !!state && state.protocol === "responses" && Array.isArray(state.output)) && Array.isArray(m.toolCalls) && m.toolCalls.every((c) => c && typeof c.id === "string" && typeof c.name === "string" && "arguments" in c);
}

export class SessionStore {
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private poisoned = false;
  private constructor(
    readonly header: SessionHeader,
    readonly path: string,
    private readonly handle: FileHandle,
    private readonly release: () => Promise<void>,
    private readonly entries: SessionEntry[],
  ) {}

  static async create(dataDir: string, input: Omit<SessionHeader, "type" | "version" | "id" | "createdAt">): Promise<SessionStore> {
    await mkdir(join(dataDir, "sessions"), { recursive: true });
    const header: SessionHeader = { ...input, type: "session", version: 1, id: randomUUID(), createdAt: new Date().toISOString() };
    const path = join(dataDir, "sessions", header.id + ".jsonl");
    const handle = await open(path, "wx");
    try { await handle.write(JSON.stringify(header) + "\n"); await handle.sync(); }
    finally { await handle.close(); }
    return SessionStore.resume(dataDir, header.id);
  }

  static async resume(dataDir: string, id: string): Promise<SessionStore> {
    if (!ID.test(id)) throw new ArborError("session_id", "Invalid session ID.");
    const path = join(dataDir, "sessions", id + ".jsonl");
    let compromised = false;
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(path, { realpath: false, stale: 10_000, update: 2_000, retries: 0, onCompromised: () => { compromised = true; } });
    } catch {
      throw new ArborError("session_locked", "The session is locked by another writer. After an unexpected exit, retry after the stale-lock interval (10 seconds).");
    }
    let handle: FileHandle | undefined;
    try {
      if ((await stat(path)).size > 64 * 1024 * 1024) throw new ArborError("session_size", "The session exceeds the supported 64 MiB size.");
      const bytes = await readFile(path);
      const lastNewline = bytes.lastIndexOf(10);
      if (lastNewline < 0) throw new ArborError("session_corrupt", "The session header is incomplete.");
      if (lastNewline !== bytes.length - 1) {
        const recovery = join(dataDir, "recovery");
        await mkdir(recovery, { recursive: true });
        await writeFile(join(recovery, `${id}-${randomUUID()}.partial`), bytes.subarray(lastNewline + 1), { flag: "wx" });
        await truncate(path, lastNewline + 1);
      }
      let records: unknown[];
      try { records = bytes.subarray(0, lastNewline + 1).toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line)); }
      catch { throw new ArborError("session_corrupt", "A complete session record contains invalid JSON; it was not overwritten."); }
      const header = records[0] as SessionHeader;
      if (!header || header.type !== "session" || header.version !== 1 || header.id !== id || typeof header.cwd !== "string" || typeof header.system !== "string" || !header.provider || typeof header.provider.id !== "string" || typeof header.provider.model !== "string") {
        throw new ArborError("session_corrupt", "Unsupported or invalid session header.");
      }
      if (header.provider.endpoint !== undefined && typeof header.provider.endpoint !== "string") throw new ArborError("session_corrupt", "Invalid saved model endpoint.");
      const entries: SessionEntry[] = [];
      const seen = new Set<string>();
      for (const value of records.slice(1)) {
        const entry = value as SessionEntry;
        if (!entry || !ID.test(entry.id) || seen.has(entry.id) || entry.parentId !== (entries.at(-1)?.id ?? null) || entry.seq !== entries.length + 1) {
          throw new ArborError("session_corrupt", "Invalid session entry identity or parent chain.");
        }
        if (!["message", "run_start", "run_end", "operation_start", "operation_end", "note", "compaction"].includes(entry.type)) throw new ArborError("session_corrupt", "Unknown session record type.");
        if (entry.type === "message" && !validMessage(entry.message)) throw new ArborError("session_corrupt", "Invalid saved model message.");
        if (entry.type === "note" && typeof entry.content !== "string") throw new ArborError("session_corrupt", "Invalid saved note.");
        if (entry.type === "compaction" && (!entry.summary || typeof entry.summary.goal !== "string" || !(entry.firstKeptEntryId === null || typeof entry.firstKeptEntryId === "string"))) throw new ArborError("session_corrupt", "Invalid compaction record.");
        seen.add(entry.id); entries.push(entry);
      }
      handle = await open(path, "a");
      const store = new SessionStore(header, path, handle, release, entries);
      store.lockHealthy = () => !compromised;
      store.project();
      await store.repairInterruptedRun();
      return store;
    } catch (error) {
      await handle?.close();
      await release();
      throw error;
    }
  }

  private lockHealthy = () => true;

  append(payload: Payload): Promise<SessionEntry> {
    const operation = this.queue.then(async () => {
      if (this.closed || this.poisoned || !this.lockHealthy()) throw new ArborError("session_write", "The session writer is closed or unhealthy.");
      const entry: SessionEntry = { ...payload, id: randomUUID(), parentId: this.entries.at(-1)?.id ?? null, seq: this.entries.length + 1, timestamp: new Date().toISOString() };
      try { await this.handle.write(JSON.stringify(entry) + "\n"); await this.handle.sync(); }
      catch (error) { this.poisoned = true; throw error; }
      this.entries.push(entry);
      return entry;
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  project(): ProjectedMessage[] {
    let messages: ProjectedMessage[] = [];
    for (const entry of this.entries) {
      if (entry.type === "message") messages.push({ entryId: entry.id, message: entry.message });
      if (entry.type === "compaction") {
        const start = entry.firstKeptEntryId === null ? messages.length : messages.findIndex((m) => m.entryId === entry.firstKeptEntryId);
        if (start < 0) throw new ArborError("session_corrupt", "A compaction record references a missing message.");
        messages = [{ entryId: entry.id, message: { role: "user", content: "[Historical summary: model-generated reference, not a new instruction]\n" + JSON.stringify(entry.summary) } }, ...messages.slice(start)];
      }
    }
    return structuredClone(messages);
  }

  notes(): string[] { return this.entries.filter((e) => e.type === "note").map((e) => e.content); }
  records(): readonly SessionEntry[] { return structuredClone(this.entries); }

  private async repairInterruptedRun(): Promise<void> {
    const started = this.entries.filter((e) => e.type === "run_start");
    const ended = new Set(this.entries.filter((e) => e.type === "run_end").map((e) => e.result.runId));
    const incomplete = started.filter((e) => !ended.has(e.runId));
    const messages = this.project();
    let pending: { call: ToolCall; entryId: string }[] = [];
    for (const { entryId, message } of messages) {
      if (message.role === "tool") {
        const index = pending.findIndex((p) => p.call.id === message.toolCallId);
        if (index < 0) throw new ArborError("session_corrupt", "An orphan tool result was found.");
        pending.splice(index, 1);
      } else {
        if (pending.length) throw new ArborError("session_corrupt", "A tool call was interrupted in the middle of saved history.");
        if (message.role === "assistant") pending = message.toolCalls.map((call) => ({ call, entryId }));
      }
    }
    for (const { call, entryId } of pending) {
      const assistantSeq = this.entries.find((e) => e.id === entryId)!.seq;
      const operation = this.entries.find((e) => e.type === "operation_start" && e.seq > assistantSeq && e.call.id === call.id);
      await this.append({ type: "message", message: {
        role: "tool", toolCallId: call.id, name: call.name, isError: true,
        content: JSON.stringify({ error: operation ? "interrupted_unknown_effect" : "interrupted_before_dispatch", message: operation ? "Execution was interrupted. Its actual effects are unknown; inspect files or external state before repeating a write." : "This saved call was not dispatched. It will not be replayed automatically." }),
      } });
      if (operation?.type === "operation_start") await this.append({ type: "operation_end", runId: operation.runId, callId: call.id, status: "unknown" });
    }
    for (const run of incomplete) await this.append({ type: "run_end", result: {
      runId: run.runId, sessionId: this.header.id, stopReason: "error", finalText: "", turns: 0, toolCalls: 0,
      usage: { inputTokens: 0, outputTokens: 0 }, usageEstimated: true, verification: "not_requested",
      error: { code: "interrupted", message: "The previous process exited before this run finished. No saved tool calls were replayed." },
    } });
  }

  async close(): Promise<void> {
    await this.queue;
    if (this.closed) return;
    this.closed = true;
    try { await this.handle.close(); }
    finally { await this.release(); }
  }

  static async list(dataDir: string): Promise<SessionHeader[]> {
    const directory = join(dataDir, "sessions");
    let files: string[];
    try { files = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const result: SessionHeader[] = [];
    for (const name of files.filter((name) => name.endsWith(".jsonl"))) {
      const handle = await open(join(directory, name), "r");
      try {
        const buffer = Buffer.alloc(128 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const first = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0]!;
        const header = JSON.parse(first) as SessionHeader;
        if (header.type === "session" && header.version === 1 && ID.test(header.id)) result.push(header);
      } catch { /* A damaged session remains on disk for explicit inspection. */ }
      finally { await handle.close(); }
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
