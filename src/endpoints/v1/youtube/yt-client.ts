import {
  calculateFullJitterBackoff,
  extractRetryAfterMs,
} from "../../../../lib/queue/fallback-queue";

const MAX_YOUTUBE_WAIT_MS = 2000;

export function sanitizeYoutubeAccessToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 4096) return null;
  // RFC 6750 Bearer tokens must never contain whitespace or control characters
  if (/[\s\x00-\x1f\x7f]/.test(trimmed)) return null;
  return trimmed;
}

export function extractYoutubeStatusCode(err: any): number | undefined {
  const candidates = [
    err?.status,
    err?.code,
    err?.statusCode,
    err?.response?.status,
    err?.response?.statusCode,
  ];
  for (const c of candidates) {
    const n = typeof c === "number" ? c : Number(c);
    if (Number.isInteger(n) && n >= 100 && n <= 599) {
      return n;
    }
  }
  return undefined;
}

function isRetryableYoutubeError(err: any): boolean {
  const status = extractYoutubeStatusCode(err);
  return status === 429 || status === 503;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Executes a Google YouTube API call with bounded Full-Jitter retry on HTTP 429 / 503.
 * Respects upstream Retry-After headers while capping single waits to <= 2000ms
 * so serverless functions never stall on long quota lockouts.
 */
export async function executeYoutubeWithRetry<T>(
  action: () => Promise<T>,
  maxRetries = 2,
  only429 = false,
): Promise<T> {
  const rawMax = process.env.YOUTUBE_RETRY_MAX?.trim();
  const effectiveMax =
    rawMax && /^\d+$/.test(rawMax)
      ? Math.min(3, Math.max(0, Number.parseInt(rawMax, 10)))
      : maxRetries;

  for (let attempt = 0; ; attempt++) {
    try {
      return await action();
    } catch (err: any) {
      const status = extractYoutubeStatusCode(err);
      const retryable = only429
        ? status === 429
        : isRetryableYoutubeError(err);
      if (!retryable || attempt >= effectiveMax) {
        throw err;
      }
      const retryAfterMs = extractRetryAfterMs(err);
      if (retryAfterMs !== undefined && retryAfterMs > MAX_YOUTUBE_WAIT_MS) {
        // Upstream requested a long cooldown; fail fast and surface Retry-After to caller
        throw err;
      }
      const waitMs = calculateFullJitterBackoff(
        attempt,
        150,
        MAX_YOUTUBE_WAIT_MS,
        retryAfterMs,
      );
      await sleep(waitMs);
    }
  }
}

/**
 * Formats and handles YouTube API errors without dumping sensitive Gaxios request configs/headers.
 * Preserves HTTP 429 + Retry-After on upstream rate limits; maps other upstream errors to HTTP 400.
 */
export function handleYoutubeError(
  label: string,
  error: any,
  set: any,
  fallbackMessage: string,
): { success: false; message: string } {
  const status = extractYoutubeStatusCode(error);
  const rawMsg =
    typeof error?.message === "string" && error.message.trim()
      ? error.message.trim()
      : fallbackMessage;

  console.error(
    `[YouTube:${label}] status=${status ?? "ERR"} message=${rawMsg.slice(0, 300)}`,
  );

  if (status === 429) {
    set.status = 429;
    const retryMs = extractRetryAfterMs(error);
    const retrySec = retryMs
      ? Math.max(1, Math.min(3600, Math.ceil(retryMs / 1000)))
      : 5;
    set.headers = set.headers || {};
    set.headers["retry-after"] = String(retrySec);
    return {
      success: false,
      message: rawMsg,
    };
  }

  set.status = 400;
  return {
    success: false,
    message: rawMsg,
  };
}
