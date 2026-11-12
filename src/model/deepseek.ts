import { ArborError } from "../errors.js";
import { ChatCompletionsProvider, type ChatCompletionsOptions } from "./chat-completions.js";

export interface DeepSeekOptions extends Omit<ChatCompletionsOptions, "id" | "model" | "baseUrl"> {
  model?: string;
  baseUrl?: string;
}

export class DeepSeekProvider extends ChatCompletionsProvider {
  constructor(options: DeepSeekOptions) {
    if (!options.apiKey.trim()) throw new ArborError("configuration", "Set DEEPSEEK_API_KEY before starting Arbor.");
    super({ ...options, id: "deepseek", model: options.model ?? "deepseek-flash", baseUrl: options.baseUrl ?? "https://api.deepseek.com" });
  }

  protected override requestParameters(): Record<string, unknown> { return { thinking: { type: "disabled" } }; }
}
