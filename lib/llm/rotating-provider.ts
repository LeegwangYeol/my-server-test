/**
 * Rotating LLM Provider Implementation
 * Target: lib/llm/rotating-provider.ts
 */

import type { LLMProvider, LLMStreamRequest } from "./types";
import type { IKeyStore, KeyConfig } from "./key-manager/types";
import { executeWithResilientFailover, type HandshakeResult } from "./key-manager/executor";

export interface RotatingProviderOptions {
  /** Default model ID when request does not specify one */
  defaultModel?: string;
  /** Extra headers for OpenRouter traffic attribution */
  extraHeaders?: Record<string, string>;
  /** Maximum retry attempts across candidate keys (default: 3) */
  maxAttempts?: number;
  /** Per-attempt network timeout in milliseconds (default: 6000ms) */
  perAttemptTimeoutMs?: number;
}

export class RotatingLLMProvider implements LLMProvider {
  public readonly name = "openrouter-rotating";

  private readonly keyStore: IKeyStore;
  private readonly keyConfigMap: Map<string, KeyConfig>;
  private readonly defaultModel: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly maxAttempts: number;
  private readonly perAttemptTimeoutMs: number;
  private syncPromise: Promise<void> | null = null;

  constructor(
    keyStore: IKeyStore,
    keyConfigMap: Map<string, KeyConfig>,
    options?: RotatingProviderOptions
  ) {
    this.keyStore = keyStore;
    this.keyConfigMap = keyConfigMap;
    this.defaultModel = options?.defaultModel ?? "openai/gpt-4o-mini";
    this.extraHeaders = options?.extraHeaders ?? {
      "HTTP-Referer": "https://tokki.app",
      "X-Title": "Tokki AI",
    };
    this.maxAttempts = options?.maxAttempts ?? 3;
    this.perAttemptTimeoutMs = options?.perAttemptTimeoutMs ?? 6000;
  }

  /**
   * Idempotently seeds keys, weights, and account metadata in the store.
   * Cached to run only once per provider instance across warm serverless requests.
   */
  public async ensureSynced(): Promise<void> {
    if (!this.syncPromise) {
      this.syncPromise = this.keyStore.syncKeys(
        Array.from(this.keyConfigMap.values())
      );
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

    return executeWithResilientFailover(
      this.keyStore,
      this.keyConfigMap,
      async (apiKey: string, attemptSignal?: AbortSignal) => {
        const primaryModel = req.model || this.defaultModel;
        return fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            ...this.extraHeaders,
          },
          body: JSON.stringify({
            model: primaryModel,
            models: [primaryModel, "openai/gpt-4o-mini"],
            messages: req.messages,
            max_tokens: req.maxTokens ?? 512,
            temperature: req.temperature ?? 0.7,
            stream: true,
          }),
          signal: attemptSignal,
        });
      },
      this.maxAttempts,
      clientSignal
    );
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
    let streamErrorMessage = "";

    const onAbort = () => {
      streamStatusCode = 499;
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
          streamErrorMessage = "Client disconnected";
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);

          if (!line || line.startsWith(":")) continue;
          if (line === "data: [DONE]") return;

          if (line.startsWith("data: ")) {
            try {
              const json = JSON.parse(line.slice(6));
              const token = json?.choices?.[0]?.delta?.content;
              if (token) yield token;
            } catch {
              // Ignore partial or unparseable SSE frame
            }
          }
        }
      }
    } catch (streamErr: any) {
      if (clientSignal?.aborted || streamStatusCode === 499) {
        streamStatusCode = 499;
        streamErrorMessage = "Client disconnected";
      } else {
        streamStatusCode = 500;
        streamErrorMessage = streamErr?.message || "Stream read error";
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
      await this.safeRelease(
        keyId,
        leaseToken,
        streamStatusCode,
        streamStatusCode === 200 || streamStatusCode === 499 ? 0 : 2000,
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

