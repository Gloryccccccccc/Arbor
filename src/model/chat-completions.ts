import { createParser } from "eventsource-parser";
import { ArborError, throwIfAborted } from "../errors.js";
import { modelEndpoint } from "./endpoint.js";
import type { AssistantMessage, ModelEvent, ModelProvider, ModelRequest, Usage } from "../types.js";

export interface ChatCompletionsOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  id?: string;
  contextWindow?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class ChatCompletionsProvider implements ModelProvider {
  readonly id: string;
  readonly model: string;
  readonly contextWindow: number;
  readonly endpointIdentity: string;
  private readonly endpoint: string;
  private readonly options: ChatCompletionsOptions;

  constructor(options: ChatCompletionsOptions) {
    if (!options.apiKey.trim()) throw new ArborError("configuration", "Set ARBOR_API_KEY before starting Arbor.");
    if (!options.model.trim()) throw new ArborError("configuration", "Specify the exact model ID from your provider's console.");
    this.options = options;
    this.id = options.id ?? "compatible";
    this.model = options.model;
    this.contextWindow = options.contextWindow ?? 64_000;
    this.endpoint = modelEndpoint(options.baseUrl, "chat/completions");
    this.endpointIdentity = this.endpoint;
  }

  protected requestParameters(): Record<string, unknown> { return {}; }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const deadline = AbortSignal.timeout(this.options.timeoutMs ?? 60_000);
    const combined = AbortSignal.any([signal, deadline]);
    const messages = [
      { role: "system", content: request.system },
      ...request.messages.map((message) => {
        if (message.role === "assistant") {
          return {
            role: "assistant",
            content: message.content || null,
            ...(message.reasoningContent !== undefined ? { reasoning_content: message.reasoningContent } : {}),
            ...(message.toolCalls.length ? {
              tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
            } : {}),
          };
        }
        if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
        return { role: "user", content: message.content };
      }),
    ];
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(this.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model, messages, stream: true, stream_options: { include_usage: true },
          max_tokens: request.maxOutputTokens, ...this.requestParameters(),
          ...(request.tools.length ? { tools: request.tools.map((tool) => ({ type: "function", function: tool })) } : {}),
        }),
        signal: combined,
      });
    } catch {
      throwIfAborted(signal);
      throw new ArborError(deadline.aborted ? "provider_timeout" : "provider_network", deadline.aborted ? "The model request timed out." : "Could not connect to the model endpoint.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ArborError("provider_http", `The model endpoint returned HTTP ${response.status}.`);
    }
    if (!response.body) throw new ArborError("provider_protocol", "The model endpoint returned an empty stream.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const queue: string[] = [];
    let parserError = false;
    const parser = createParser({ onEvent: (event) => queue.push(event.data), onError: () => { parserError = true; } });
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    let content = "";
    let reasoningContent: string | undefined;
    let finishReason: string | undefined;
    let done = false;
    let usage: Usage | undefined;
    let receivedBytes = 0;
    try {
      while (!done) {
        throwIfAborted(combined);
        const chunk = await reader.read();
        if (chunk.done) break;
        receivedBytes += chunk.value.byteLength;
        if (receivedBytes > 8 * 1024 * 1024) throw new ArborError("provider_protocol", "The model stream exceeded the response limit.");
        parser.feed(decoder.decode(chunk.value, { stream: true }));
        if (parserError) throw new ArborError("provider_protocol", "The model returned malformed SSE events.");
        while (queue.length) {
          const data = queue.shift()!;
          if (data === "[DONE]") { done = true; break; }
          let payload: Record<string, unknown>;
          try { payload = JSON.parse(data) as Record<string, unknown>; }
          catch { throw new ArborError("provider_protocol", "The model stream contained invalid JSON."); }
          if (payload.error) throw new ArborError("provider_protocol", "The model stream reported an error.");
          const rawUsage = payload.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
          if (rawUsage && Number.isSafeInteger(rawUsage.prompt_tokens) && Number.isSafeInteger(rawUsage.completion_tokens) && rawUsage.prompt_tokens! >= 0 && rawUsage.completion_tokens! >= 0) {
            usage = { inputTokens: rawUsage.prompt_tokens!, outputTokens: rawUsage.completion_tokens! };
          }
          const choices = payload.choices as { delta?: { content?: string; reasoning_content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[] | undefined;
          if (!Array.isArray(choices)) throw new ArborError("provider_protocol", "The stream omitted its choices array.");
          const choice = choices[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta;
          if (typeof delta?.reasoning_content === "string") reasoningContent = (reasoningContent ?? "") + delta.reasoning_content;
          if (typeof delta?.content === "string") {
            content += delta.content;
            yield { type: "text_delta", text: delta.content };
          }
          for (const part of delta?.tool_calls ?? []) {
            if (!Number.isSafeInteger(part.index) || part.index < 0 || part.index >= 32) throw new ArborError("provider_protocol", "Invalid tool call index.");
            const call = calls.get(part.index) ?? { id: "", name: "", arguments: "" };
            if (part.id) call.id += part.id;
            if (part.function?.name) call.name += part.function.name;
            if (part.function?.arguments) {
              call.arguments += part.function.arguments;
              yield { type: "tool_delta", index: part.index, argumentsDelta: part.function.arguments };
            }
            if (call.arguments.length > 1_000_000) throw new ArborError("provider_protocol", "Tool arguments exceeded the size limit.");
            calls.set(part.index, call);
          }
        }
      }
      throwIfAborted(combined);
      if (!done || !["stop", "tool_calls"].includes(finishReason ?? "")) {
        throw new ArborError("provider_incomplete", "The model response was interrupted or exceeded its output limit; no tools were executed.");
      }
      if ((calls.size > 0) !== (finishReason === "tool_calls")) throw new ArborError("provider_protocol", "The model's finish reason and tool calls disagree.");
      const toolCalls: AssistantMessage["toolCalls"] = [];
      const ids = new Set<string>();
      for (const [, call] of [...calls].sort(([a], [b]) => a - b)) {
        if (!call.id || !call.name || ids.has(call.id)) throw new ArborError("provider_protocol", "Missing or duplicate tool call identity.");
        ids.add(call.id);
        let args: unknown;
        try { args = JSON.parse(call.arguments); }
        catch { throw new ArborError("provider_protocol", "The model returned incomplete tool arguments; no tools were executed."); }
        toolCalls.push({ id: call.id, name: call.name, arguments: args });
      }
      yield { type: "response", message: { role: "assistant", content, toolCalls, ...(reasoningContent !== undefined ? { reasoningContent } : {}) }, usage };
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
