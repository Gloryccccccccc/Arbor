import { describe, expect, it } from "vitest";
import { ResponsesProvider } from "../src/model/responses.js";
import type { ModelEvent, ModelRequest } from "../src/types.js";

const request: ModelRequest = { system: "Inspect before editing", messages: [{ role: "user", content: "Read a file" }], tools: [{ name: "read", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }], maxOutputTokens: 4096 };
const textItem = (text: string) => ({ id: "msg-1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
const callItem = { id: "fc-item-1", type: "function_call", status: "completed", call_id: "call-1", name: "read", arguments: '{"path":"a.ts"}' };
const reasoningItem = { id: "rs-1", type: "reasoning", summary: [], encrypted_content: "opaque-reasoning-fixture" };
const event = (value: unknown) => "data: " + JSON.stringify(value) + "\n\n";
const completed = (output: unknown[], status = "completed") => event({ type: "response.completed", response: { status, output, usage: { input_tokens: 20, output_tokens: 8 } } });
function stream(source: string, chunkSize = 1): Response {
  const bytes = new TextEncoder().encode(source);
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.subarray(i, i + chunkSize));
    controller.close();
  } }), { headers: { "Content-Type": "text/event-stream" } });
}
async function collect(provider: ResponsesProvider, input = request, signal = new AbortController().signal): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const item of provider.stream(input, signal)) events.push(item);
  return events;
}
function provider(source: string): ResponsesProvider {
  return new ResponsesProvider({ apiKey: "test", model: "gpt-6.1-sol", baseUrl: "https://example.com/v1", fetch: async () => stream(source) });
}

describe("Responses provider", () => {
  it("streams fragmented Unicode and function deltas, and completes without a DONE marker", async () => {
    let body: Record<string, unknown> = {};
    let endpoint = "";
    const source = event({ type: "response.output_text.delta", delta: "读取" })
      + event({ type: "response.output_text.delta", delta: "文件" })
      + event({ type: "response.function_call_arguments.delta", output_index: 2, item_id: "fc-item-1", delta: '{"path":' })
      + event({ type: "response.function_call_arguments.delta", output_index: 2, item_id: "fc-item-1", delta: '"a.ts"}' })
      + completed([reasoningItem, textItem("读取文件"), callItem]);
    const model = new ResponsesProvider({ apiKey: "private-test-key", model: "gpt-6.1-sol", baseUrl: "https://example.com/v1/responses/", fetch: async (url, init) => {
      endpoint = String(url); body = JSON.parse(String(init?.body)); return stream(source);
    } });
    const events = await collect(model);
    expect(events.filter((item) => item.type === "text_delta").map((item) => item.text).join("")).toBe("读取文件");
    expect(events.filter((item) => item.type === "tool_delta")).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "response", message: { content: "读取文件", toolCalls: [{ id: "call-1", name: "read", arguments: { path: "a.ts" } }], providerState: { protocol: "responses", output: [reasoningItem, textItem("读取文件"), callItem] } }, usage: { inputTokens: 20, outputTokens: 8 } });
    expect(endpoint).toBe("https://example.com/v1/responses");
    expect(body).toMatchObject({ model: "gpt-6.1-sol", instructions: request.system, store: false, stream: true, max_output_tokens: 4096, include: ["reasoning.encrypted_content"], tools: [{ type: "function", name: "read", strict: false }] });
    expect(body).not.toHaveProperty("messages");
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("previous_response_id");
    expect(JSON.stringify(events)).not.toContain("private-test-key");
  });

  it("replays complete output items and returns tool results by call_id, preserving encrypted reasoning", async () => {
    const bodies: { input: Record<string, unknown>[] }[] = [];
    const model = new ResponsesProvider({ apiKey: "test", model: "gpt-6.1-sol", baseUrl: "https://example.com/v1", fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return stream(bodies.length === 1 ? completed([reasoningItem, callItem]) : completed([textItem("Done")]));
    } });
    const last = (await collect(model)).at(-1)!;
    if (last.type !== "response") throw new Error("missing response");
    await collect(model, { ...request, messages: [...request.messages, last.message, { role: "tool", toolCallId: "call-1", name: "read", content: "evidence", isError: false }] });
    expect(bodies[1]!.input).toEqual([
      { role: "user", content: "Read a file" }, reasoningItem, callItem,
      { type: "function_call_output", call_id: "call-1", output: "evidence" },
    ]);
  });

  it.each([
    ["missing terminal event", event({ type: "response.output_item.done", item: callItem }) + "data: [DONE]\n\n"],
    ["incomplete response", event({ type: "response.incomplete", response: { status: "incomplete", output: [callItem] } })],
    ["failed response", event({ type: "response.failed", response: { error: { message: "private-error" } } })],
    ["error event", event({ type: "error", message: "private-error" })],
    ["incomplete arguments", completed([{ ...callItem, arguments: '{"path":' }])],
    ["duplicate call ID", completed([callItem, { ...callItem, id: "different-item" }])],
    ["incomplete output item", completed([{ ...callItem, status: "in_progress" }])],
    ["invalid completion status", completed([callItem], "incomplete")],
    ["invalid event JSON", "data: {broken}\n\n"],
    ["mismatched final text", event({ type: "response.output_text.delta", delta: "hello" }) + completed([textItem("different")])],
  ])("rejects %s without yielding an executable response", async (_name, source) => {
    const events: ModelEvent[] = [];
    await expect((async () => { for await (const item of provider(source).stream(request, new AbortController().signal)) events.push(item); })()).rejects.toThrow();
    expect(events.some((item) => item.type === "response")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("private-error");
  });

  it("rejects inconsistent persisted state before making another HTTP request", async () => {
    let called = false;
    const model = new ResponsesProvider({ apiKey: "test", model: "gpt-6.1-sol", baseUrl: "https://example.com/v1", fetch: async () => { called = true; return stream(completed([])); } });
    await expect(collect(model, { ...request, messages: [{ role: "assistant", content: "", toolCalls: [{ id: "other-call", name: "read", arguments: { path: "a.ts" } }], providerState: { protocol: "responses", output: [callItem] } }] })).rejects.toThrow("disagree");
    expect(called).toBe(false);
  });

  it("reports HTTP status without leaking the response body or credentials", async () => {
    const model = new ResponsesProvider({ apiKey: "private-key", model: "gpt-6.1-sol", baseUrl: "https://example.com/v1", fetch: async () => new Response("private-key", { status: 401 }) });
    await expect(collect(model)).rejects.toThrow("HTTP 401");
  });

  it("does not send an already cancelled request", async () => {
    let called = false;
    const model = new ResponsesProvider({ apiKey: "test", model: "gpt-6.1-sol", baseUrl: "https://example.com/v1", fetch: async () => { called = true; return stream(completed([])); } });
    const controller = new AbortController(); controller.abort();
    await expect(collect(model, request, controller.signal)).rejects.toThrow();
    expect(called).toBe(false);
  });
});
