/**
 * Rotating LLM Provider Implementation
 * Target: lib/llm/rotating-provider.ts
 */

import type { LLMProvider, LLMStreamRequest } from "./types";
import type { IKeyStore, KeyConfig } from "./key-manager/types";
import {
  HealthAndCooldownEngine,
  type OpenRouterErrorPayload,
} from "./key-manager/engine";
import {
  executeWithResilientFailover,
  KeyManagerError,
  type HandshakeResult,
} from "./key-manager/executor";

const MAX_SSE_BUFFER_CHARS = 256_000;

export interface RotatingProviderOptions {
  /** Default model ID when request does not specify one */
  defaultModel?: string;
  /** Extra headers for OpenRouter traffic attribution */
  extraHeaders?: Record<string, string>;
  /** Maximum retry attempts across candidate keys (default: 3) */
  maxAttempts?: number;
  /** Per-attempt network timeout in milliseconds (default: 6000ms) */
  perAttemptTimeoutMs?: number;
  /** Per-chunk idle stall timeout during Phase-2 SSE streaming (default: 25000ms < 45s ZSET lease) */
  chunkTimeoutMs?: number;
}

export class RotatingLLMProvider implements LLMProvider {
  public readonly name = "openrouter-rotating";

  private readonly keyStore: IKeyStore;
  private readonly keyConfigMap: Map<string, KeyConfig>;
  private readonly defaultModel: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly maxAttempts: number;
  private readonly perAttemptTimeoutMs: number;
  private readonly chunkTimeoutMs: number;
  private syncPromise: Promise<void> | null = null;

  constructor(
    keyStore: IKeyStore,
    keyConfigMap: Map<string, KeyConfig>,
    options?: RotatingProviderOptions
  ) {
    this.keyStore = keyStore;
    this.keyConfigMap = keyConfigMap;
    this.defaultModel = options?.defaultModel ?? "openai/gpt-4o-mini";
    const rawExtra = options?.extraHeaders ?? {
      "HTTP-Referer": "https://tokki.app",
      "X-Title": "Tokki AI",
    };
    const safeExtra: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawExtra)) {
      const cleanVal = String(v ?? "").replace(/[\r\n\x00-\x1f\x7f]+/g, " ").trim();
      let byteSafe = "";
      for (const ch of cleanVal) {
        byteSafe += (ch.codePointAt(0) ?? 0) > 0xff ? encodeURIComponent(ch) : ch;
      }
      safeExtra[k] = byteSafe;
    }
    this.extraHeaders = safeExtra;
    this.maxAttempts =
      options?.maxAttempts ?? Math.max(3, Math.min(keyConfigMap.size, 5));
    this.perAttemptTimeoutMs = options?.perAttemptTimeoutMs ?? 6000;
    this.chunkTimeoutMs = options?.chunkTimeoutMs ?? 25_000;
  }

  /**
   * Idempotently seeds keys, weights, and account metadata in the store.
   * Cached to run only once per provider instance across warm serverless requests.
   */
  public async ensureSynced(): Promise<void> {
    if (!this.syncPromise) {
      this.syncPromise = this.keyStore
        .syncKeys(Array.from(this.keyConfigMap.values()))
        .catch((err) => {
          this.syncPromise = null;
          throw err;
        });
    }
    await this.syncPromise;
  }

  /**
   * Phase 1: Pre-Stream Handshake
   * Executes multi-attempt key selection and HTTP handshake with upstream OpenRouter.
   * 
   * On HTTP 200 OK headers from upstream:
   *   - Acknowledges handshake (<500ms), graduating WARMUP keys to ACTIVE.
   *   - Returns HandshakeResult containing the live response body and lease credentials.
   * On failure (all keys rate-limited or exhausted):
   *   - Throws typed KeyManagerError before any response is committed to the client.
   */
  public async preStreamHandshake(
    req: LLMStreamRequest,
    clientSignal?: AbortSignal
  ): Promise<HandshakeResult> {
    await this.ensureSynced();

    const handshake = await executeWithResilientFailover(
      this.keyStore,
      this.keyConfigMap,
      async (apiKey: string, attemptSignal?: AbortSignal) => {
        const primaryModel = req.model || this.defaultModel;
        const fallbackModel =
          primaryModel === "openai/gpt-4o-mini"
            ? "google/gemini-2.0-flash-lite-001"
            : "openai/gpt-4o-mini";
        return fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            ...this.extraHeaders,
          },
          body: JSON.stringify({
            model: primaryModel,
            models: [primaryModel, fallbackModel],
            messages: req.messages,
            max_tokens: req.maxTokens ?? 512,
            temperature: req.temperature ?? 0.7,
            stream: true,
          }),
          signal: attemptSignal,
        });
      },
      this.maxAttempts,
      clientSignal,
      this.perAttemptTimeoutMs
    );

    if (!handshake.response.ok) {
      const errBody = await handshake.response.text().catch(() => "");
      throw new KeyManagerError(
        `UPSTREAM_CLIENT_ERROR (${handshake.response.status}): ${errBody.slice(0, 200) || handshake.response.statusText}`,
        handshake.response.status,
        undefined,
        "UPSTREAM_CLIENT_ERROR"
      );
    }

    return handshake;
  }

  /**
   * Phase 2: Stream Consumption
   * Consumes SSE chunks from an established upstream HandshakeResult.
   * Guarantees that the concurrency lease is released in the finally block.
   */
  public async *streamFromHandshake(
    handshake: HandshakeResult,
    clientSignal?: AbortSignal
  ): AsyncIterable<string> {
    const { response, keyId, leaseToken } = handshake;

    if (!response.body) {
      await this.safeRelease(keyId, leaseToken, 500, 2000, "Empty response body");
      throw new Error("STREAM_ERROR: Response body is null.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let streamStatusCode = 200;
    let streamCooldownMs = 0;
    let streamErrorMessage = "";

    const classifyInBandError = (json: OpenRouterErrorPayload & { error?: any }): Error => {
      const rawCode = Number(json?.error?.code);
      const code = Number.isFinite(rawCode) && rawCode > 0 ? rawCode : 502;
      const errMsg =
        typeof json?.error?.message === "string" && json.error.message.trim()
          ? json.error.message.trim()
          : `Upstream SSE error (${code})`;

      const outage = HealthAndCooldownEngine.isUpstreamProviderOutage(json);
      if (outage.isOutage && (code === 429 || code === 503)) {
        streamStatusCode = 0;
        streamCooldownMs = 0;
        streamErrorMessage = `Provider outage: ${outage.provider || "UpstreamProvider"}`;
      } else if (code === 402) {
        streamStatusCode = 402;
        streamCooldownMs = Infinity;
        streamErrorMessage = errMsg;
      } else if (
        code === 401 ||
        (code === 403 && !HealthAndCooldownEngine.isPromptModerationError(json))
      ) {
        streamStatusCode = code;
        streamCooldownMs = Infinity;
        streamErrorMessage = errMsg;
      } else if (code === 403) {
        streamStatusCode = 0;
        streamCooldownMs = 0;
        streamErrorMessage = errMsg;
      } else if (code === 429) {
        streamStatusCode = 429;
        streamCooldownMs = HealthAndCooldownEngine.calculate429Cooldown({}, 1);
        streamErrorMessage = errMsg;
      } else {
        streamStatusCode = code >= 500 || code === 408 ? code : 502;
        streamCooldownMs = 2000;
        streamErrorMessage = errMsg;
      }
      return new Error(`UPSTREAM_SSE_ERROR (${code}): ${errMsg}`);
    };

    const readChunkWithTimeout = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      if (!Number.isFinite(this.chunkTimeoutMs) || this.chunkTimeoutMs <= 0) {
        return reader.read();
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOutError: Error | null = null;
      try {
        const res = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              streamStatusCode = 504;
              streamCooldownMs = 2000;
              streamErrorMessage = `SSE stream stalled > ${this.chunkTimeoutMs}ms`;
              timedOutError = new Error(
                `STREAM_TIMEOUT: Upstream SSE stalled for ${this.chunkTimeoutMs}ms`,
              );
              reject(timedOutError);
              void reader.cancel("STREAM_TIMEOUT").catch(() => {});
            }, this.chunkTimeoutMs);
          }),
        ]);
        if (timedOutError) throw timedOutError;
        return res;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };

    const onAbort = () => {
      streamStatusCode = 499;
      streamCooldownMs = 0;
      streamErrorMessage = "Client disconnected";
      void reader.cancel().catch(() => {});
    };

    if (clientSignal) {
      if (clientSignal.aborted) {
        onAbort();
      } else {
        clientSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    try {
      while (true) {
        if (clientSignal?.aborted) {
          streamStatusCode = 499;
          streamCooldownMs = 0;
          streamErrorMessage = "Client disconnected";
          break;
        }

        const { done, value } = await readChunkWithTimeout();
        if (done) {
          buffer += decoder.decode();
          if (buffer.trim()) {
            const tailLine = buffer.trim();
            if (tailLine.startsWith("data:")) {
              const payload = tailLine.slice(5).trim();
              if (payload === "[DONE]") return;
              let parsedErr: Error | null = null;
              let token: string | undefined;
              try {
                const json = JSON.parse(payload);
                if (json?.error) {
                  parsedErr = classifyInBandError(json);
                } else {
                  token = json?.choices?.[0]?.delta?.content;
                }
              } catch {
                // Ignore partial or unparseable SSE frame
              }
              if (parsedErr) throw parsedErr;
              if (token) yield token;
            }
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_SSE_BUFFER_CHARS) {
          streamStatusCode = 502;
          streamCooldownMs = 2000;
          streamErrorMessage = "Upstream SSE frame exceeded buffer limit";
          throw new Error("STREAM_ERROR: Upstream SSE frame exceeded buffer limit");
        }
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);

          if (!line || line.startsWith(":")) continue;

          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") return;
            let parsedErr: Error | null = null;
            let token: string | undefined;
            try {
              const json = JSON.parse(payload);
              if (json?.error) {
                parsedErr = classifyInBandError(json);
              } else {
                token = json?.choices?.[0]?.delta?.content;
              }
            } catch {
              // Ignore partial or unparseable SSE frame
            }
            if (parsedErr) throw parsedErr;
            if (token) yield token;
          }
        }
      }
    } catch (streamErr: any) {
      if (clientSignal?.aborted || streamStatusCode === 499) {
        streamStatusCode = 499;
        streamCooldownMs = 0;
        streamErrorMessage = "Client disconnected";
      } else {
        if (streamStatusCode === 200) {
          streamStatusCode = 500;
          streamCooldownMs = 2000;
        }
        if (!streamErrorMessage) {
          streamErrorMessage = streamErr?.message || "Stream read error";
        }
        throw streamErr;
      }
    } finally {
      if (clientSignal) {
        clientSignal.removeEventListener("abort", onAbort);
      }
      try {
        reader.releaseLock();
      } catch {
        /* noop */
      }
      // Cancel upstream response stream to stop further token generation
      void response.body.cancel().catch(() => {});

      // Phase 2: Guaranteed slot reclamation
      let effectiveCooldownMs =
        streamStatusCode === 200 || streamStatusCode === 499 || streamStatusCode === 0
          ? 0
          : streamCooldownMs || 2000;
      if (streamStatusCode === 429 && streamCooldownMs !== Infinity) {
        const allStates = await this.keyStore.getAllStates().catch(() => []);
        const cur = allStates.find((s) => s.id === keyId);
        const next429Count = (cur?.consecutive429s || 0) + 1;
        effectiveCooldownMs = HealthAndCooldownEngine.calculate429Cooldown(
          {},
          next429Count,
        );
      }
      await this.safeRelease(
        keyId,
        leaseToken,
        streamStatusCode,
        effectiveCooldownMs,
        streamErrorMessage
      );
    }
  }

  /**
   * Drop-in LLMProvider stream interface.
   * Chains preStreamHandshake and streamFromHandshake seamlessly.
   */
  public async *stream(
    req: LLMStreamRequest,
    clientSignal?: AbortSignal
  ): AsyncIterable<string> {
    const handshake = await this.preStreamHandshake(req, clientSignal);
    yield* this.streamFromHandshake(handshake, clientSignal);
  }

  /**
   * Polymorphic helper supporting both positional arguments and KeyReleaseOutcome objects.
   */
  private async safeRelease(
    keyId: string,
    leaseToken: string,
    statusCode: number,
    cooldownMs: number,
    errorMessage?: string
  ): Promise<void> {
    const store = this.keyStore as any;
    try {
      if (typeof store.releaseKey === "function") {
        await store.releaseKey(keyId, leaseToken, {
          statusCode,
          cooldownMs,
          errorMessage: errorMessage || "",
        });
      }
    } catch {
      await store.releaseKey(keyId, leaseToken, statusCode, cooldownMs, errorMessage);
    }
  }
}

// Aliases for drop-in flexibility
export { RotatingLLMProvider as RotatingProvider };
export type ILlmProvider = LLMProvider;
export { MemoryKeyStore } from "./key-manager/stores/memory";

