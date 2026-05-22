/**
 * Provider-agnostic LLM streaming contract. Every concrete provider
 * (OpenAI, OpenRouter, Anthropic, local, ...) implements this so the
 * caller never knows which vendor it's talking to.
 */

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface LLMStreamRequest {
  messages: ChatMessage[];
  /** Provider-specific model id; falls back to provider default. */
  model?: string;
  /** Sampling temperature (0–2). Defaults to 0.7. */
  temperature?: number;
  /** Hard cap on output tokens. */
  maxTokens?: number;
}

export interface LLMProvider {
  /** Short identifier used in logs and the /v2/ask response error path. */
  readonly name: string;
  /**
   * Async-iterable of token chunks (strings). The caller is responsible
   * for emitting them as SSE / concatenating / etc. Throws on transport
   * or API errors so the caller can fall through to a fallback.
   */
  stream(req: LLMStreamRequest, signal?: AbortSignal): AsyncIterable<string>;
}
