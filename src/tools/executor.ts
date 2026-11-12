import { Ajv, type ValidateFunction } from "ajv";
import { ArborError, abortable, errorInfo, throwIfAborted } from "../errors.js";
import type { ApprovalHandler, HarnessEvent, PermissionMode, ToolCall, ToolMessage, ToolSchema } from "../types.js";
import { ArtifactStore, clipText } from "./artifacts.js";
import { LocalOperations } from "./local.js";

export interface ToolContext { runId: string; signal: AbortSignal }
export interface ToolDefinition extends ToolSchema {
  effect: "read" | "write" | "exec";
  execute(input: Record<string, unknown>, context: ToolContext): Promise<unknown>;
}
interface Registered { definition: ToolDefinition; validate: ValidateFunction }
export class ToolRegistry {
  private readonly tools = new Map<string, Registered>();
  private readonly ajv = new Ajv({ strict: true, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
  register(definition: ToolDefinition): void {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(definition.name) || this.tools.has(definition.name)) throw new ArborError("tool_registration", "Invalid or duplicate tool name.");
    this.tools.set(definition.name, { definition, validate: this.ajv.compile(definition.parameters) });
  }
  schemas(): ToolSchema[] { return [...this.tools.values()].map(({ definition: d }) => ({ name: d.name, description: d.description, parameters: d.parameters })); }
  get(name: string): Registered | undefined { return this.tools.get(name); }
}

export function codingTools(operations: LocalOperations): ToolRegistry {
  const registry = new ToolRegistry();
  const path = { type: "string", minLength: 1, maxLength: 4096 };
  const hash = { type: "string", pattern: "^[0-9a-f]{64}$" };
  const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
  registry.register({
    name: "read", effect: "read", description: "Read workspace text and obtain its sha256 before editing. Use artifact:<id> for saved output. Default: 200 lines (max 1000). For long lines/results, keep the same line range and use nextOffset as offset to read subsequent character pages.",
    parameters: schema({ path, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 }, offset: { type: "integer", minimum: 0 }, maxChars: { type: "integer", minimum: 1, maximum: 8000 } }, ["path"]),
    execute: (input, ctx) => {
      const start = (input.startLine as number | undefined) ?? 1;
      const end = input.endLine as number | undefined;
      if (end !== undefined && (end < start || end - start >= 1000)) throw new ArborError("line_range", "Read at most 1000 lines in increasing order.");
      return operations.read(input.path as string, start, end, ctx.signal, (input.offset as number | undefined) ?? 0, (input.maxChars as number | undefined) ?? 4000);
    },
  });
  registry.register({
    name: "write", effect: "write", description: "Create a UTF-8 file. To overwrite an existing file, read it first and supply expectedHash equal to its sha256. Writes are limited to 1 MiB.",
    parameters: schema({ path, content: { type: "string", maxLength: 1_048_576 }, expectedHash: hash }, ["path", "content"]),
    execute: (input, ctx) => operations.write(input.path as string, input.content as string, input.expectedHash as string | undefined, ctx.signal),
  });
  registry.register({
    name: "edit", effect: "write", description: "Replace exactly one occurrence of oldText with newText. Read the file first; expectedHash must match its current sha256. No implicit replace-all.",
    parameters: schema({ path, oldText: { type: "string", minLength: 1, maxLength: 1_048_576 }, newText: { type: "string", maxLength: 1_048_576 }, expectedHash: hash }, ["path", "oldText", "newText", "expectedHash"]),
    execute: (input, ctx) => operations.edit(input.path as string, input.oldText as string, input.newText as string, input.expectedHash as string, ctx.signal),
  });
  registry.register({
    name: "exec", effect: "exec", description: "Run a shell command in the trusted local workspace, for searches/builds/tests. This is not a sandbox. Set a timeout; output is bounded and saved as an artifact. Commands are not retried automatically.",
    parameters: schema({ command: { type: "string", minLength: 1, maxLength: 16_384 }, timeoutMs: { type: "integer", minimum: 100, maximum: 120_000 } }, ["command"]),
    execute: (input, ctx) => operations.exec(input.command as string, (input.timeoutMs as number | undefined) ?? 30_000, ctx.signal),
  });
  return registry;
}

interface ExecutorOptions {
  registry: ToolRegistry;
  permissions: PermissionMode;
  approve?: ApprovalHandler;
  artifacts: ArtifactStore;
  approvalTimeoutMs?: number;
  emit: (event: Omit<HarnessEvent, "sessionId" | "timestamp">) => void;
  beforeExecute: (call: ToolCall, runId: string) => Promise<void>;
}

export class ToolExecutor {
  constructor(private readonly options: ExecutorOptions) {}
  schemas(): ToolSchema[] { return this.options.registry.schemas(); }

  async execute(call: ToolCall, context: ToolContext): Promise<ToolMessage> {
    try {
      throwIfAborted(context.signal);
      const registered = this.options.registry.get(call.name);
      if (!registered) throw new ArborError("unknown_tool", `Unknown tool: ${call.name}`);
      if (!registered.validate(call.arguments)) throw new ArborError("schema_error", "Invalid tool arguments: " + JSON.stringify(registered.validate.errors));
      const tool = registered.definition;
      if (tool.effect !== "read") {
        if (this.options.permissions === "read-only") throw new ArborError("permission_denied", "This session allows read tools only.");
        if (this.options.permissions === "ask") {
          if (!this.options.approve) throw new ArborError("permission_denied", "This action needs approval, but no approval handler is available.");
          this.options.emit({ type: "approval_requested", runId: context.runId, call, effect: tool.effect });
          const signal = AbortSignal.any([context.signal, AbortSignal.timeout(this.options.approvalTimeoutMs ?? 180_000)]);
          let approved: boolean;
          try { approved = await abortable(this.options.approve({ runId: context.runId, call: structuredClone(call), effect: tool.effect, signal }), signal); }
          catch (error) {
            if (signal.aborted && !context.signal.aborted) throw new ArborError("approval_timeout", "Approval timed out; the tool was not executed.");
            throw error;
          }
          if (!approved) throw new ArborError("permission_denied", "The user denied this tool call.");
          this.options.emit({ type: "approval_granted", runId: context.runId, callId: call.id });
        }
      }
      throwIfAborted(context.signal);
      await this.options.beforeExecute(call, context.runId);
      throwIfAborted(context.signal);
      this.options.emit({ type: "tool_started", runId: context.runId, call });
      const data = await tool.execute(structuredClone(call.arguments) as Record<string, unknown>, context);
      if (call.name === "read" && data && typeof data === "object" && "content" in data && typeof data.content === "string" && "offset" in data) {
        const page = data as { content: string; offset: number; nextOffset: number | null };
        while (Buffer.byteLength(JSON.stringify(page)) > 12_000 && page.content.length > 1) {
          page.content = page.content.slice(0, Math.floor(page.content.length / 2));
          page.nextOffset = page.offset + page.content.length;
        }
      }
      const encoded = JSON.stringify(data) ?? "null";
      const clipped = clipText(encoded, 12_000);
      let content = encoded;
      if (clipped.truncated) {
        const artifactId = await this.options.artifacts.put(encoded);
        content = JSON.stringify({ truncated: true, artifactId, preview: clipped.text });
      }
      const result = data as { exitCode?: number | null; timedOut?: boolean; cancelled?: boolean; cleanupError?: boolean } | null;
      const isError = call.name === "exec" && Boolean(result && (result.exitCode !== 0 || result.timedOut || result.cancelled || result.cleanupError));
      return { role: "tool", toolCallId: call.id, name: call.name, content, isError,
        ...(call.name === "exec" && result ? { execution: { cleanupError: Boolean(result.cleanupError), timedOut: Boolean(result.timedOut) } } : {}),
      };
    } catch (error) {
      return { role: "tool", toolCallId: call.id, name: call.name, isError: true, content: JSON.stringify({ error: errorInfo(error).code, message: errorInfo(error).message }) };
    }
  }
}
