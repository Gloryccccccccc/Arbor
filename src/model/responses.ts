import { createParser } from "eventsource-parser";
import { ArborError, throwIfAborted } from "../errors.js";
import type { AssistantMessage, ModelEvent, ModelProvider, ModelRequest, Usage } from "../types.js";
import { modelEndpoint } from "./endpoint.js";

export interface ResponsesOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  contextWindow?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

function protocolError(message: string): never { throw new ArborError("provider_protocol", message); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

/** Only complete Responses output becomes executable. The original items retain reasoning and item IDs. */
function decodeOutput(value: unknown): AssistantMessage {
  if (!Array.isArray(value) || value.length > 128) return protocolError("Invalid Responses output array.");
  const output: Record<string, unknown>[] = [];
  const toolCalls: AssistantMessage["toolCalls"] = [];
  const ids = new Set<string>();
  let content = "";
  for (const item of value) {
    if (!record(item)) return protocolError("Invalid Responses output item.");
    if (item.status !== undefined && item.status !== "completed") return protocolError("A Responses output item is incomplete.");
    if (item.type === "message") {
      if (item.role !== "assistant" || !Array.isArray(item.content)) return protocolError("Invalid Responses assistant message.");
      for (const part of item.content) {
        if (!record(part)) return protocolError("Invalid Responses message content.");
        if (part.type === "output_text" && typeof part.text === "string") content += part.text;
        else if (part.type === "refusal" && typeof part.refusal === "string") content += part.refusal;
        else return protocolError("Unsupported Responses message content.");
      }
    } else if (item.type === "function_call") {
      if (typeof item.call_id !== "string" || !item.call_id || ids.has(item.call_id) || typeof item.name !== "string" || !item.name || typeof item.arguments !== "string" || item.arguments.length > 1_000_000 || toolCalls.length >= 32) return protocolError("Invalid or duplicate Responses function call.");
      let args: unknown;
      try { args = JSON.parse(item.arguments); }
      catch { return protocolError("Responses returned incomplete function arguments; this turn's tools were not executed."); }
      ids.add(item.call_id);
      toolCalls.push({ id: item.call_id, name: item.name, arguments: args });
    } else if (item.type !== "reasoning") return protocolError("The model returned an unsupported Responses output item.");
    output.push(item);
  }
  return { role: "assistant", content, toolCalls, providerState: { protocol: "responses", output } };
}

function responseInput(request: ModelRequest): Record<string, unknown>[] {
  return request.messages.flatMap((message): Record<string, unknown>[] => {
    if (message.role === "user") return [{ role: "user", content: message.content }];
    if (message.role === "tool") return [{ type: "function_call_output", call_id: message.toolCallId, output: message.content }];
    if (message.providerState) {
      if (message.providerState.protocol !== "responses") return protocolError("The saved assistant state uses another model protocol.");
      const decoded = decodeOutput(message.providerState.output);
      if (decoded.content !== message.content || JSON.stringify(decoded.toolCalls) !== JSON.stringify(message.toolCalls)) return protocolError("The saved Responses items disagree with the assistant message.");
      return message.providerState.output;
    }
    return [
      ...(message.content ? [{ role: "assistant", content: message.content }] : []),
      ...message.toolCalls.map((call) => ({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) })),
    ];
  });
}

export class ResponsesProvider implements ModelProvider {
  readonly id = "responses";
  readonly model: string;
  readonly contextWindow: number;
  readonly endpointIdentity: string;
  private readonly endpoint: string;

  constructor(private readonly options: ResponsesOptions) {
    if (!options.apiKey.trim()) throw new ArborError("configuration", "Set ARBOR_API_KEY before starting Arbor.");
    if (!options.model.trim()) throw new ArborError("configuration", "Specify the exact model ID from your provider's console.");
    this.model = options.model;
    this.contextWindow = options.contextWindow ?? 64_000;
    this.endpoint = modelEndpoint(options.baseUrl, "responses");
    this.endpointIdentity = this.endpoint;
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const input = responseInput(request);
    const deadline = AbortSignal.timeout(this.options.timeoutMs ?? 60_000);
    const combined = AbortSignal.any([signal, deadline]);
    let response: Response;
    try {
      throwIfAborted(combined);
      response = await (this.options.fetch ?? fetch)(this.endpoint, {
        method: "POST", headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model, instructions: request.system, input, stream: true, store: false,
          include: ["reasoning.encrypted_content"], max_output_tokens: request.maxOutputTokens,
          ...(request.tools.length ? { tools: request.tools.map((tool) => ({ type: "function", ...tool, strict: false })) } : {}),
        }), signal: combined,
      });
    } catch {
      throwIfAborted(signal);
      throw new ArborError(deadline.aborted ? "provider_timeout" : "provider_network", deadline.aborted ? "The model request timed out." : "Could not connect to the model endpoint.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ArborError("provider_http", `The model endpoint returned HTTP ${response.status}.`);
    }
    if (!response.body) return protocolError("The model endpoint returned an empty stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const queue: string[] = [];
    let parserError = false;
    const parser = createParser({ onEvent: (event) => queue.push(event.data), onError: () => { parserError = true; } });
    let receivedBytes = 0;
    let streamedText = "";
    let complete: AssistantMessage | undefined;
    let usage: Usage | undefined;
    try {
      while (!complete) {
        throwIfAborted(combined);
        const chunk = await reader.read();
        if (chunk.done) break;
        receivedBytes += chunk.value.byteLength;
        if (receivedBytes > 8 * 1024 * 1024) return protocolError("The model stream exceeded the response limit.");
        parser.feed(decoder.decode(chunk.value, { stream: true }));
        if (parserError) return protocolError("The model returned malformed SSE events.");
        while (queue.length) {
          const data = queue.shift()!;
          // Responses terminates with response.completed, not Chat Completions' [DONE].
          if (data === "[DONE]") continue;
          let payload: unknown;
          try { payload = JSON.parse(data); }
          catch { return protocolError("The model stream contained invalid JSON."); }
          if (!record(payload) || typeof payload.type !== "string") return protocolError("Invalid Responses stream event.");
          if (["error", "response.failed", "response.incomplete"].includes(payload.type)) throw new ArborError("provider_incomplete", "The Responses stream failed or exceeded its output limit; this turn's tools were not executed.");
          if (payload.type === "response.output_text.delta") {
            if (typeof payload.delta !== "string") return protocolError("Invalid Responses text delta.");
            streamedText += payload.delta;
            yield { type: "text_delta", text: payload.delta };
          }
          if (payload.type === "response.function_call_arguments.delta") {
            const index = payload.output_index;
            if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= 128 || typeof payload.delta !== "string") return protocolError("Invalid Responses function delta.");
            yield { type: "tool_delta", index, argumentsDelta: payload.delta };
          }
          if (payload.type === "response.completed") {
            const result = payload.response;
            if (!record(result) || result.status !== "completed" || result.error) return protocolError("The Responses result is incomplete.");
            complete = decodeOutput(result.output);
            if (!complete.content.startsWith(streamedText)) return protocolError("The completed Responses text disagrees with its stream.");
            if (complete.content.length > streamedText.length) yield { type: "text_delta", text: complete.content.slice(streamedText.length) };
            const counters = result.usage;
            if (record(counters) && typeof counters.input_tokens === "number" && typeof counters.output_tokens === "number" && Number.isSafeInteger(counters.input_tokens) && Number.isSafeInteger(counters.output_tokens) && counters.input_tokens >= 0 && counters.output_tokens >= 0) usage = { inputTokens: counters.input_tokens, outputTokens: counters.output_tokens };
            break;
          }
        }
      }
      throwIfAborted(combined);
      if (!complete) throw new ArborError("provider_incomplete", "The Responses stream ended before completion; this turn's tools were not executed.");
      yield { type: "response", message: complete, usage };
    } catch (error) {
      throwIfAborted(signal);
      if (deadline.aborted) throw new ArborError("provider_timeout", "The model stream timed out.");
      if (error instanceof ArborError) throw error;
      throw new ArborError("provider_network", "The model stream disconnected before completion.");
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
