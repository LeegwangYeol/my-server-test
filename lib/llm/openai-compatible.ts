import type { LLMProvider, LLMStreamRequest } from "./types";

/**
 * Wraps any OpenAI-compatible Chat Completions endpoint as an LLMProvider.
 *
 * Covers, with zero per-vendor code:
 *   - OpenRouter     https://openrouter.ai/api/v1
 *   - OpenAI         https://api.openai.com/v1
 *   - Google Gemini  https://generativelanguage.googleapis.com/v1beta/openai
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
 *
 * ── 429 / 5xx 자동 재시도 ─────────────────────────────────────────────
 * 무료 티어(예: Gemini 분당 15요청)에서는 순간 몰림으로 429 가 흔하다. 첫 응답이
 * 429/500/502/503/504 이면 스트리밍을 **시작하기 전에** 백오프 후 다시 요청한다.
 *   - 재시도는 오직 "첫 응답 헤더" 단계에서만 한다. 스트림이 시작된 뒤에는 절대
 *     재시도하지 않는다 — 이미 내보낸 토큰이 중복될 수 있기 때문.
 *   - 대기: 0.5s → 1s → 2s (±20% 지터). 서버가 Retry-After 를 주면 그 값을 따른다 (소수점 초 지원 및 ±20% 지터).
 *   - 한 번의 대기가 LLM_RETRY_MAX_WAIT_MS(기본 5s) 를 넘으면 기다리지 않고 바로
 *     실패시킨다 — Vercel Hobby 함수 제한(10s) 안에 답을 내야 하기 때문.
 *   - AbortSignal 이 오면 대기 중이라도 즉시 중단한다.
 *   - env: LLM_RETRY_MAX (기본 3, 0이면 끔), LLM_RETRY_MAX_WAIT_MS (기본 5000)
 * 이 재시도는 "몰림을 몇 초 펴주는" 완충이지 한도를 늘리는 게 아니다.
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
    const resp = await this.fetchWithRetry(req, signal);

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

  /**
   * POST the chat request; on 429/5xx (or a network error) back off and retry
   * a bounded number of times. Resolves only with an `ok` response.
   * 실패 시 던지는 에러 문구는 기존 형식 `[name] status statusText: body` 를 유지한다
   * (/v2/ask 의 에러 처리 경로가 그 형식에 의존).
   */
  private async fetchWithRetry(
    req: LLMStreamRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
    const maxRetries = envInt("LLM_RETRY_MAX", 3, 0, 5);
    const maxWaitMs = envInt("LLM_RETRY_MAX_WAIT_MS", 5000, 0, 8000);
    const body = JSON.stringify({
      model: req.model ?? this.defaultModel,
      messages: req.messages,
      stream: true,
      temperature: req.temperature ?? 0.7,
      max_tokens: req.maxTokens ?? envInt("LLM_MAX_TOKENS", 512, 1, 4096),
    });

    for (let attempt = 0; ; attempt++) {
      let resp: Response;
      try {
        resp = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            ...this.extraHeaders,
          },
          body,
        });
      } catch (err) {
        // 취소는 재시도 대상이 아니다. 네트워크 오류만 한정 재시도.
        if (signal?.aborted || isAbortError(err) || attempt >= maxRetries) {
          throw err;
        }
        const wait = backoffMs(attempt);
        console.warn(
          `[${this.name}] network error → retry ${attempt + 1}/${maxRetries} in ${wait}ms`,
        );
        await sleep(wait, signal);
        continue;
      }

      if (resp.ok) return resp;

      const retryable = RETRYABLE_STATUS.has(resp.status);
      if (retryable && attempt < maxRetries) {
        const wait =
          parseRetryAfterMs(
            resp.headers.get("retry-after"),
            resp.headers.get("date"),
          ) ?? backoffMs(attempt);
        if (wait <= maxWaitMs) {
          // 본문은 안 읽고 커넥션만 정리한 뒤 다시 시도.
          void resp.body?.cancel().catch(() => {});
          console.warn(
            `[${this.name}] ${resp.status} → retry ${attempt + 1}/${maxRetries} in ${wait}ms`,
          );
          await sleep(wait, signal);
          continue;
        }
        // Retry-After 가 서버리스 예산보다 길면 기다리지 않고 바로 실패시킨다.
      }

      const text = await safeText(resp);
      throw new Error(
        `[${this.name}] ${resp.status} ${resp.statusText}: ${text.slice(0, 300)}`,
      );
    }
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** 0.5s → 1s → 2s … (2s 에서 정지), ±20% 지터. */
export function backoffMs(attempt: number): number {
  const base = Math.min(500 * 2 ** attempt, 2000);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/**
 * `Retry-After: 3` (초), 소수점 초 (예: `1.5`), 또는 HTTP-date 를 ms 로 파싱.
 * RFC 9110 준수 및 동시 요청 몰림(thundering herd) 방지를 위해 ±20% 지터를 가산한다.
 * 해석 불가면 undefined 반환.
 */
export function parseRetryAfterMs(
  header: string | null,
  dateHeader?: string | null,
): number | undefined {
  if (!header) return undefined;
  const v = header.trim();
  if (!v) return undefined;

  // 1. Delta-seconds: 정수("3") 또는 소수점("1.5", "0.8"), 선택적 's' 접미사
  if (/^(?:\d+(?:\.\d*)?|\.\d+)s?$/i.test(v)) {
    const sec = parseFloat(v);
    if (!Number.isNaN(sec) && Number.isFinite(sec) && sec >= 0) {
      const baseMs = sec * 1000;
      if (baseMs === 0) return 0;
      // ±20% 랜덤 지터 (0.8 ~ 1.2 배)
      const jitter = 0.8 + Math.random() * 0.4;
      return Math.max(0, Math.round(baseMs * jitter));
    }
    return undefined;
  }

  // 음수 또는 순수 숫자형식(예: "-1", "123.456.789")은 HTTP-date 로 취급하지 않음
  if (!Number.isNaN(Number(v))) {
    return undefined;
  }

  // 2. RFC 9110 HTTP-date (예: "Wed, 21 Oct 2026 07:28:00 GMT")
  const at = Date.parse(v);
  if (!Number.isNaN(at)) {
    let skew = 0;
    if (dateHeader) {
      const serverTime = Date.parse(dateHeader);
      if (!Number.isNaN(serverTime)) {
        skew = serverTime - Date.now();
      }
    }
    const diff = at - (Date.now() + skew);
    if (diff <= 0) return 0;
    // ±20% 랜덤 지터 (0.8 ~ 1.2 배)
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.max(0, Math.round(diff * jitter));
  }

  return undefined;
}

function envInt(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "AbortError"
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  try {
    return new DOMException("The operation was aborted.", "AbortError");
  } catch {
    return Object.assign(new Error("The operation was aborted."), {
      name: "AbortError",
    });
  }
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "<unreadable body>";
  }
}
