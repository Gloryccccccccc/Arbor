import { ArborError, errorInfo, throwIfAborted } from "../errors.js";
import { estimateTokens, requestFits } from "../context.js";
import type { AssistantMessage, HarnessEvent, Message, ModelProvider, ModelRequest, RunBudget, RunResult, ToolCall, ToolMessage } from "../types.js";

export interface LoopHost {
  buildRequest(maxOutputTokens: number): ModelRequest;
  appendMessage(message: Message): Promise<void>;
  executeTool(call: ToolCall, runId: string, signal: AbortSignal): Promise<ToolMessage>;
  saveToolResult(message: ToolMessage, runId: string): Promise<void>;
  takeSteering(): string[];
  hasSteering(): boolean;
  emit(event: Omit<HarnessEvent, "sessionId" | "timestamp">): void;
}

function validateResponse(message: AssistantMessage): void {
  if (message.role !== "assistant" || typeof message.content !== "string" || !Array.isArray(message.toolCalls) || message.toolCalls.length > 32) throw new ArborError("provider_protocol", "Invalid assistant response.");
  if (message.reasoningContent !== undefined && typeof message.reasoningContent !== "string") throw new ArborError("provider_protocol", "Invalid provider reasoning field.");
  const ids = new Set<string>();
  for (const call of message.toolCalls) {
    if (!call.id || typeof call.id !== "string" || !call.name || typeof call.name !== "string" || ids.has(call.id) || !("arguments" in call)) throw new ArborError("provider_protocol", "Invalid or duplicate tool call identity.");
    try {
      if (JSON.stringify(call.arguments) === undefined) throw new Error("Not JSON");
    } catch { throw new ArborError("provider_protocol", "Tool arguments must be serializable JSON."); }
    ids.add(call.id);
  }
}

/** The core owns scheduling, not files, terminals, session formats, or model HTTP protocols. */
export async function runAgentLoop(input: {
  runId: string;
  sessionId: string;
  provider: ModelProvider;
  budget: RunBudget;
  signal: AbortSignal;
  host: LoopHost;
}): Promise<RunResult> {
  const { runId, sessionId, provider, budget, host } = input;
  const deadline = AbortSignal.timeout(budget.maxDurationMs);
  const signal = AbortSignal.any([input.signal, deadline]);
  const result: RunResult = { runId, sessionId, stopReason: "model_stop", finalText: "", turns: 0, toolCalls: 0, usage: { inputTokens: 0, outputTokens: 0 }, usageEstimated: false, verification: "not_requested" };
  const errors = new Map<string, number>();
  let cleanupUnconfirmed = false;
  try {
    while (true) {
      throwIfAborted(signal);
      for (const content of host.takeSteering()) await host.appendMessage({ role: "user", content });
      if (result.turns >= budget.maxTurns || result.toolCalls >= budget.maxToolCalls) { result.stopReason = "budget"; break; }
      const request = host.buildRequest(budget.maxOutputTokens);
      const estimated = estimateTokens(request);
      if (!requestFits(request, provider.contextWindow)) throw new ArborError("context_budget", "The context is too large for this model. Run /compact or start a new session.");
      if (result.usage.inputTokens + result.usage.outputTokens + estimated + request.maxOutputTokens > budget.maxTotalTokens) { result.stopReason = "budget"; break; }
      result.turns++;
      host.emit({ type: "turn_started", runId, turn: result.turns });
      let response: AssistantMessage | undefined;
      let usage: { inputTokens: number; outputTokens: number } | undefined;
      let visibleOutput = "";
      try {
        for await (const event of provider.stream(request, signal)) {
          throwIfAborted(signal);
          if (response) throw new ArborError("provider_protocol", "The provider emitted data after its final response.");
          if (event.type === "text_delta") { visibleOutput += event.text; host.emit({ type: "text_delta", runId, text: event.text }); }
          if (event.type === "tool_delta") { visibleOutput += event.argumentsDelta; host.emit({ type: "tool_delta", runId, index: event.index, argumentsDelta: event.argumentsDelta }); }
          if (event.type === "response") { response = event.message; usage = event.usage; }
        }
      } finally {
        const measured = usage && Number.isSafeInteger(usage.inputTokens) && Number.isSafeInteger(usage.outputTokens) && usage.inputTokens >= 0 && usage.outputTokens >= 0;
        result.usage.inputTokens += measured ? usage!.inputTokens : estimated;
        result.usage.outputTokens += measured ? usage!.outputTokens : response ? estimateTokens(response) : Math.ceil(Buffer.byteLength(visibleOutput) / 2);
        result.usageEstimated ||= !measured;
      }
      throwIfAborted(signal);
      if (!response) throw new ArborError("provider_incomplete", "The provider returned no complete response.");
      validateResponse(response);
      if (usage && (!Number.isSafeInteger(usage.inputTokens) || !Number.isSafeInteger(usage.outputTokens) || usage.inputTokens < 0 || usage.outputTokens < 0)) throw new ArborError("provider_protocol", "Invalid model usage counters.");
      await host.appendMessage(response);
      host.emit({ type: "message_saved", runId, message: response });
      if (!response.toolCalls.length) {
        result.finalText = response.content;
        host.emit({ type: "turn_finished", runId, turn: result.turns });
        if (host.hasSteering()) continue;
        break;
      }
      let stopBatch = false;
      for (const call of response.toolCalls) {
        let message: ToolMessage;
        if (signal.aborted || stopBatch || result.toolCalls >= budget.maxToolCalls) {
          message = { role: "tool", toolCallId: call.id, name: call.name, isError: true, content: JSON.stringify({ error: signal.aborted ? "cancelled_before_dispatch" : "budget_before_dispatch", message: "This call was not executed." }) };
          if (!signal.aborted) { result.stopReason = "budget"; stopBatch = true; }
        } else {
          result.toolCalls++;
          message = await host.executeTool(call, runId, signal);
        }
        await host.saveToolResult(message, runId);
        cleanupUnconfirmed ||= Boolean(message.execution?.cleanupError);
        host.emit({ type: "tool_finished", runId, result: message });
        if (message.isError && !signal.aborted) {
          const fingerprint = JSON.stringify([call.name, call.arguments, message.content]);
          const count = (errors.get(fingerprint) ?? 0) + 1;
          errors.set(fingerprint, count);
          if (count >= 3) { result.stopReason = "budget"; stopBatch = true; }
        }
      }
      throwIfAborted(signal);
      host.emit({ type: "turn_finished", runId, turn: result.turns });
      if (stopBatch || result.usage.inputTokens + result.usage.outputTokens >= budget.maxTotalTokens) { result.stopReason = "budget"; break; }
    }
  } catch (error) {
    result.stopReason = input.signal.aborted ? "cancelled" : deadline.aborted ? "timeout" : "error";
    result.error = errorInfo(error);
  }
  if (cleanupUnconfirmed) {
    result.stopReason = "error";
    result.error = { code: "cleanup_unconfirmed", message: "The command stopped, but process-tree cleanup could not be confirmed. Inspect the execution environment before continuing." };
  }
  return result;
}
