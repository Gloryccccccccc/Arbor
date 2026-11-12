import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import { throwIfAborted } from "../src/errors.js";
import type { AssistantMessage, ModelEvent, ModelProvider, ModelRequest, Usage } from "../src/types.js";

const testRoot = fileURLToPath(new URL("../.work/tests/", import.meta.url));
const directories: string[] = [];
export async function workspace(): Promise<string> {
  await mkdir(testRoot, { recursive: true });
  const path = await mkdtemp(join(testRoot, "case-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const target = resolve(directory);
    if (!target.startsWith(resolve(testRoot) + sep) || !target.split(sep).at(-1)!.startsWith("case-")) throw new Error("Unsafe test cleanup path");
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

export const reply = (content: string, toolCalls: AssistantMessage["toolCalls"] = []): AssistantMessage => ({ role: "assistant", content, toolCalls });
type Step = AssistantMessage | ((request: ModelRequest, signal: AbortSignal) => AssistantMessage | Promise<AssistantMessage>);
export class FakeProvider implements ModelProvider {
  readonly id = "fake";
  readonly model = "test-model";
  contextWindow = 100_000;
  readonly requests: ModelRequest[] = [];
  usage: Usage | undefined = { inputTokens: 10, outputTokens: 5 };
  constructor(private readonly steps: Step[]) {}
  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    throwIfAborted(signal);
    this.requests.push(structuredClone(request));
    const step = this.steps.shift();
    if (!step) throw new Error("FakeProvider exhausted");
    const message = typeof step === "function" ? await step(request, signal) : step;
    throwIfAborted(signal);
    if (message.content) yield { type: "text_delta", text: message.content };
    yield { type: "response", message, usage: this.usage };
  }
}

export const summary = JSON.stringify({ goal: "Fix the project", constraints: ["Keep public interfaces"], completed: ["Read the source"], openIssues: ["Run checks"], nextSteps: ["Verify"], references: ["source.mjs"] });
