import { describe, expect, it } from "vitest";
import { DeepSeekProvider } from "../src/model/deepseek.js";
import type { ModelEvent, ModelRequest } from "../src/types.js";

const request: ModelRequest = { system: "Rules", messages: [{ role: "user", content: "Read a file" }], tools: [{ name: "read", description: "Read", parameters: { type: "object" } }], maxOutputTokens: 1000 };
const event = (value: unknown) => "data: " + JSON.stringify(value) + "\n\n";
function mockStream(text: string, chunkSize = 7): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.subarray(i, i + chunkSize));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}
async function collect(provider: DeepSeekProvider): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const item of provider.stream(request, new AbortController().signal)) events.push(item);
  return events;
}

describe("model streaming boundary", () => {
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
