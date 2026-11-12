import { describe, expect, it } from "vitest";
import { DeepSeekProvider } from "../src/model/deepseek.js";
import { BailianProvider } from "../src/model/bailian.js";
import { ChatCompletionsProvider } from "../src/model/chat-completions.js";
import type { AssistantMessage, ModelEvent, ModelProvider, ModelRequest } from "../src/types.js";

const request: ModelRequest = { system: "Rules", messages: [{ role: "user", content: "Read a file" }], tools: [{ name: "read", description: "Read", parameters: { type: "object" } }], maxOutputTokens: 1000 };
const event = (value: unknown) => "data: " + JSON.stringify(value) + "\n\n";
function mockStream(text: string, chunkSize = 7): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.subarray(i, i + chunkSize));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}
async function collect(provider: ModelProvider): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const item of provider.stream(request, new AbortController().signal)) events.push(item);
  return events;
}

describe("model streaming boundary", () => {
  it("sends standard requests without DeepSeek or Bailian parameters to a compatible endpoint", async () => {
    let sent: Record<string, unknown> = {};
    let endpoint = "";
    const provider = new ChatCompletionsProvider({ apiKey: "test", model: "my-exact-model", baseUrl: "https://example.com/v1/chat/completions/", fetch: async (url, init) => {
      endpoint = String(url); sent = JSON.parse(String(init?.body));
      return mockStream(event({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
    } });
    await collect(provider);
    expect(endpoint).toBe("https://example.com/v1/chat/completions");
    expect(sent.model).toBe("my-exact-model");
    expect(sent).not.toHaveProperty("thinking");
    expect(sent).not.toHaveProperty("enable_thinking");
  });

  it.each(["kimi-k3", "kimi/kimi-k3", "qwen3.8-27b"])("preserves the configured Bailian model ID %s and Beijing endpoint", async (model) => {
    let sent: Record<string, unknown> = {};
    let endpoint = "";
    const provider = new BailianProvider({ apiKey: "test", model, fetch: async (url, init) => {
      endpoint = String(url); sent = JSON.parse(String(init?.body));
      return mockStream(event({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
    } });
    await collect(provider);
    expect(provider.id).toBe("bailian");
    expect(endpoint).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect(sent.model).toBe(model);
    expect(sent).not.toHaveProperty("thinking");
    expect(sent).not.toHaveProperty("enable_thinking");
  });

  it("uses an explicit workspace endpoint and only opts into enable_thinking when configured", async () => {
    let sent: Record<string, unknown> = {};
    let endpoint = "";
    const provider = new BailianProvider({ apiKey: "test", model: "configured-qwen-id", baseUrl: "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", enableThinking: false, fetch: async (url, init) => {
      endpoint = String(url); sent = JSON.parse(String(init?.body));
      return mockStream(event({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
    } });
    await collect(provider);
    expect(endpoint).toBe("https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect(sent.enable_thinking).toBe(false);
    expect(sent).not.toHaveProperty("thinking");
  });

  it("retains streamed reasoning across the full tool round trip without treating it as reply text", async () => {
    const bodies: { messages: Record<string, unknown>[] }[] = [];
    const toolStream = event({ choices: [{ delta: { reasoning_content: "Check " } }] })
      + event({ choices: [{ delta: { reasoning_content: "the file.", tool_calls: [{ index: 0, id: "r", function: { name: "read", arguments: '{"path":"a"}' } }] }, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n";
    const provider = new BailianProvider({ apiKey: "test", model: "kimi-k3", fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return mockStream(bodies.length === 1 ? toolStream : event({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n", 1);
    } });
    const events = await collect(provider);
    const last = events.at(-1)!;
    expect(last.type).toBe("response");
    if (last.type !== "response") throw new Error("missing response");
    expect(last.message).toMatchObject({ content: "", reasoningContent: "Check the file." });
    expect(events.filter((e) => e.type === "text_delta")).toEqual([]);
    const assistant: AssistantMessage = last.message;
    for await (const _ of provider.stream({ ...request, messages: [...request.messages, assistant, { role: "tool", toolCallId: "r", name: "read", content: "evidence", isError: false }] }, new AbortController().signal)) { /* consume */ }
    expect(bodies[1]?.messages[2]).toMatchObject({ role: "assistant", reasoning_content: "Check the file.", tool_calls: [{ id: "r" }] });
    expect(bodies[1]?.messages[3]).toMatchObject({ role: "tool", tool_call_id: "r" });
  });

  it("assembles fragmented UTF-8 and tool arguments, and preserves usage", async () => {
    let body: Record<string, unknown> = {};
    const source = event({ choices: [{ delta: { content: "读取文件" } }] })
      + event({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "read", arguments: '{"path":' } }] } }] })
      + event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }, finish_reason: "tool_calls" }] })
      + event({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } }) + "data: [DONE]\n\n";
    const provider = new DeepSeekProvider({ apiKey: "private-key", fetch: async (_url, init) => { body = JSON.parse(String(init?.body)); return mockStream(source, 1); } });
    const events = await collect(provider);
    const complete = events.at(-1)!;
    expect(complete.type).toBe("response");
    if (complete.type !== "response") throw new Error("missing response");
    expect(complete.message.content).toBe("读取文件");
    expect(complete.message.toolCalls).toEqual([{ id: "call-1", name: "read", arguments: { path: "a.ts" } }]);
    expect(complete.usage).toEqual({ inputTokens: 20, outputTokens: 8 });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(JSON.stringify(events)).not.toContain("private-key");
  });

  it.each([
    ["missing DONE", event({ choices: [{ delta: {}, finish_reason: "stop" }] })],
    ["length stop", event({ choices: [{ delta: {}, finish_reason: "length" }] }) + "data: [DONE]\n\n"],
    ["incomplete arguments", event({ choices: [{ delta: { tool_calls: [{ index: 0, id: "1", function: { name: "read", arguments: '{"path":' } }] }, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n"],
    ["invalid event JSON", "data: {broken}\n\ndata: [DONE]\n\n"],
  ])("rejects %s before producing an executable response", async (_name, source) => {
    const provider = new DeepSeekProvider({ apiKey: "test", fetch: async () => mockStream(source) });
    await expect(collect(provider)).rejects.toThrow();
  });

  it("round-trips assistant calls and results in their provider format", async () => {
    let sent: unknown;
    const provider = new DeepSeekProvider({ apiKey: "test", fetch: async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return mockStream(event({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
    } });
    const input: ModelRequest = { ...request, messages: [
      { role: "user", content: "Inspect" },
      { role: "assistant", content: "", toolCalls: [{ id: "call", name: "read", arguments: { path: "a" } }] },
      { role: "tool", toolCallId: "call", name: "read", content: "text", isError: false },
    ] };
    for await (const _ of provider.stream(input, new AbortController().signal)) { /* consume */ }
    expect(sent).toMatchObject({ messages: [
      { role: "system" }, { role: "user" },
      { role: "assistant", tool_calls: [{ id: "call", function: { arguments: '{"path":"a"}' } }] },
      { role: "tool", tool_call_id: "call", content: "text" },
    ] });
  });

  it("returns HTTP status without leaking provider response bodies", async () => {
    const provider = new DeepSeekProvider({ apiKey: "secret", fetch: async () => new Response("secret", { status: 401 }) });
    await expect(collect(provider)).rejects.toThrow("HTTP 401");
  });

  it("rejects credential-bearing or insecure remote endpoints", () => {
    expect(() => new DeepSeekProvider({ apiKey: "key", baseUrl: "http://example.com" })).toThrow();
    expect(() => new DeepSeekProvider({ apiKey: "key", baseUrl: "https://user:password@example.com" })).toThrow();
  });
});
