export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  toolCalls: ToolCall[];
}

export interface ToolMessage {
  role: "tool";
  toolCallId: string;
  name: string;
  content: string;
  isError: boolean;
  execution?: { cleanupError: boolean; timedOut: boolean };
}

export type Message = UserMessage | AssistantMessage | ToolMessage;

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelRequest {
  system: string;
  messages: readonly Message[];
  tools: readonly ToolSchema[];
  maxOutputTokens: number;
}

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_delta"; index: number; argumentsDelta: string }
  | { type: "response"; message: AssistantMessage; usage?: Usage };

export interface ModelProvider {
  readonly id: string;
  readonly model: string;
  readonly contextWindow: number;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

export type PermissionMode = "ask" | "read-only" | "trusted";
export interface ApprovalRequest {
  runId: string;
  call: ToolCall;
  effect: "write" | "exec";
  signal: AbortSignal;
}
export type ApprovalHandler = (request: ApprovalRequest) => Promise<boolean>;

export interface RunBudget {
  maxTurns: number;
  maxToolCalls: number;
  maxDurationMs: number;
  maxTotalTokens: number;
  maxOutputTokens: number;
}

export type StopReason = "model_stop" | "budget" | "cancelled" | "timeout" | "error";
export interface RunResult {
  runId: string;
  sessionId: string;
  stopReason: StopReason;
  finalText: string;
  turns: number;
  toolCalls: number;
  usage: Usage;
  usageEstimated: boolean;
  verification: "not_requested";
  error?: { code: string; message: string };
}

export interface HarnessEvent {
  type: string;
  sessionId: string;
  runId?: string;
  timestamp: string;
  [key: string]: unknown;
}

export interface Summary {
  goal: string;
  constraints: string[];
  completed: string[];
  openIssues: string[];
  nextSteps: string[];
  references: string[];
}

export interface CompactionReport {
  summarizedMessages: number;
  keptMessages: number;
  firstKeptEntryId: string | null;
  usage?: Usage;
}
