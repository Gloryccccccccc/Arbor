import { ArborError } from "../errors.js";
import { ChatCompletionsProvider, type ChatCompletionsOptions } from "./chat-completions.js";

export interface BailianOptions extends Omit<ChatCompletionsOptions, "id" | "baseUrl"> {
  baseUrl?: string;
  /** Omit to use the model default. Only set for models that support enable_thinking. */
  enableThinking?: boolean;
}

export class BailianProvider extends ChatCompletionsProvider {
  private readonly enableThinking: boolean | undefined;

  constructor(options: BailianOptions) {
    if (!options.apiKey.trim()) throw new ArborError("configuration", "Set DASHSCOPE_API_KEY before starting Arbor.");
    // Beijing's existing endpoint remains supported; workspace endpoints can be supplied explicitly.
    super({ ...options, id: "bailian", baseUrl: options.baseUrl ?? "https://dashscope.aliyuncs.com/compatible-mode/v1" });
    this.enableThinking = options.enableThinking;
  }

  protected override requestParameters(): Record<string, unknown> {
    return this.enableThinking === undefined ? {} : { enable_thinking: this.enableThinking };
  }
}
