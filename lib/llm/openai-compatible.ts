import type { LLMProvider, LLMStreamRequest } from "./types";

/**
 * Wraps any OpenAI-compatible Chat Completions endpoint as an LLMProvider.
 *
 * Covers, with zero per-vendor code:
 *   - OpenRouter     https://openrouter.ai/api/v1
 *   - OpenAI         https://api.openai.com/v1
 *   - Groq           https://api.groq.com/openai/v1
 *   - Together       https://api.together.xyz/v1
 *   - DeepSeek       https://api.deepseek.com
 *   - Mistral        https://api.mistral.ai/v1
 *   - Fireworks      https://api.fireworks.ai/inference/v1
 *   - Self-hosted    Ollama (with `OPENAI_API_KEY=ollama`), LM Studio, vLLM, etc.
 *
 * Streams SSE chunks of the shape:
 *     data: {"choices":[{"delta":{"content":"…"}}]}
 *     ...
 *     data: [DONE]
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: {
    name: string;
    baseUrl: string;
    apiKey: string;
    defaultModel: string;
    extraHeaders?: Record<string, string>;
  }) {
    this.name = opts.name;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.defaultModel = opts.defaultModel;
    this.extraHeaders = opts.extraHeaders ?? {};
  }

  async *stream(
    req: LLMStreamRequest,
    signal?: AbortSignal,
  ): AsyncIterable<string> {
    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model: req.model ?? this.defaultModel,
        messages: req.messages,
        stream: true,
        temperature: req.temperature ?? 0.7,
        // Hard ceiling — free OpenRouter credits reject anything bigger.
        // Honor callers below it, but never exceed it.
        max_tokens: Math.min(req.maxTokens ?? 256, 256),
      }),
    });

    if (!resp.ok) {
      const text = await safeText(resp);
      throw new Error(
        `[${this.name}] ${resp.status} ${resp.statusText}: ${text.slice(0, 300)}`,
      );
    }
    if (!resp.body) {
      throw new Error(`[${this.name}] empty response body`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events (separated by \n\n or \n).
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") return;
          try {
            const json = JSON.parse(payload);
            const delta: string | undefined =
              json?.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch {
            /* Skip malformed/keep-alive frames silently. */
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* noop */
      }
    }
  }
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "<unreadable body>";
  }
}
