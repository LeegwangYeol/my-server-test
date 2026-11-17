/**
 * SMS via Pushbullet — the user's OWN Android phone sends the text.
 *
 * Why this exists: Pushbullet is an OFFICIAL Google Play app (no APK sideload,
 * no lookalike-app confusion) and its REST API can queue an SMS that the
 * paired Android phone then sends over its own carrier plan (문자 무제한이면
 * 0원). Free accounts are capped at ~100 SMS/month — exactly one 100-명
 * holiday batch, with NO headroom for retries.
 *
 * Env:
 *   PUSHBULLET_ENV           'test' (내 동생꺼) 또는 'prod' (실제 아빠꺼). 미설정 시 'test' 우선.
 *   PUSHBULLET_TEST_ACCESS_TOKEN / PUSHBULLET_TEST_DEVICE_NICKNAME (또는 IDEN)
 *   PUSHBULLET_PROD_ACCESS_TOKEN / PUSHBULLET_PROD_DEVICE_NICKNAME (또는 IDEN)
 *
 *   (하위 호환성: PUSHBULLET_ACCESS_TOKEN 등 기존 변수명은 fallback 으로 사용)
 *   PUSHBULLET_API_URL       optional override, for tests. Default official.
 *
 * Import-safe: never throws at module load (mirrors lib/sms/phone-gateway.ts).
 * No relative imports on purpose — scripts run this file directly under
 * `node --env-file`, whose ESM resolver needs explicit extensions.
 */

const DEFAULT_API_URL = "https://api.pushbullet.com";
const DEFAULT_TIMEOUT_MS = 5000;
const RETRYABLE_PUSHBULLET_STATUS = new Set([429, 502, 503, 504]);
const MAX_PUSHBULLET_WAIT_MS = 2500;

function parsePushbulletRetryMs(headers: Headers): number | undefined {
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter) {
    if (/^\d+(\.\d+)?$/.test(retryAfter)) {
      const sec = parseFloat(retryAfter);
      if (Number.isFinite(sec) && sec >= 0) {
        return Math.ceil(sec * 1000) + 100 + Math.floor(Math.random() * 250);
      }
    }
    const parsedDate = Date.parse(retryAfter);
    if (!Number.isNaN(parsedDate)) {
      const diff = parsedDate - Date.now();
      if (diff > 0) {
        return Math.ceil(diff) + 100 + Math.floor(Math.random() * 250);
      }
    }
  }
  const reset = headers.get("x-ratelimit-reset")?.trim();
  if (reset && /^\d+$/.test(reset)) {
    const epochSec = parseInt(reset, 10);
    if (Number.isFinite(epochSec) && epochSec > 1_000_000_000) {
      const diff = epochSec * 1000 - Date.now();
      if (diff > 0) {
        return Math.ceil(diff) + 100 + Math.floor(Math.random() * 250);
      }
    }
  }
  return undefined;
}

async function fetchPushbulletWithRetry(
  url: string,
  init: Omit<RequestInit, "signal">,
): Promise<Response> {
  const rawMax = Number.parseInt(process.env.PUSHBULLET_RETRY_MAX ?? "2", 10);
  const maxRetries = Number.isInteger(rawMax)
    ? Math.max(0, Math.min(3, rawMax))
    : 2;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (res.ok || !RETRYABLE_PUSHBULLET_STATUS.has(res.status) || attempt >= maxRetries) {
      return res;
    }
    const headerWait = parsePushbulletRetryMs(res.headers);
    const expCap = Math.min(MAX_PUSHBULLET_WAIT_MS, 300 * Math.pow(2, attempt));
    const waitMs =
      headerWait !== undefined
        ? headerWait
        : Math.max(50, Math.floor(Math.random() * expCap) + 100);
    if (waitMs > MAX_PUSHBULLET_WAIT_MS) {
      return res;
    }
    void res.body?.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

export function getPushbulletConfig() {
  const envMode = process.env.PUSHBULLET_ENV?.trim().toLowerCase();
  // 명시적 prod 가 아니면 모두 test 로 취급 (테스트 우선)
  const mode = envMode === "prod" ? "PROD" : "TEST";

  const token =
    process.env[`PUSHBULLET_${mode}_ACCESS_TOKEN`]?.trim() ||
    process.env.PUSHBULLET_ACCESS_TOKEN?.trim();
  const iden =
    process.env[`PUSHBULLET_${mode}_DEVICE_IDEN`]?.trim() ||
    process.env.PUSHBULLET_DEVICE_IDEN?.trim();
  const nickname =
    process.env[`PUSHBULLET_${mode}_DEVICE_NICKNAME`]?.trim() ||
    process.env.PUSHBULLET_DEVICE_NICKNAME?.trim();

  return { mode, token, iden, nickname };
}

export function isPushbulletConfigured(): boolean {
  const conf = getPushbulletConfig();
  return Boolean(conf.token && (conf.iden || conf.nickname));
}

/** 별명 → iden 해석 결과 캐시 (환경/토큰/별명별 격리하여 교차 오염 및 메모리 누수 방지). */
const MAX_IDEN_CACHE_ENTRIES = 100;
const idenCache = new Map<string, string>();

/** 캐시 초기화 (테스트 또는 환경 변수 동적 전환 시 사용). */
export function clearDeviceIdenCache(): void {
  idenCache.clear();
}
export const clearPushbulletIdenCache = clearDeviceIdenCache;

/**
 * 보낼 기기의 iden 을 정한다.
 * IDEN 이 지정돼 있으면 그대로, 아니면 NICKNAME 으로 /v2/devices 에서 찾는다.
 */
async function resolveDeviceIden(
  base: string,
  token: string,
  conf: ReturnType<typeof getPushbulletConfig>
): Promise<string> {
  if (conf.iden) return conf.iden;

  // 캐시 키: mode + token + nickname + base 조합으로 환경 간 캐시 오염 방지
  const cacheKey = `${conf.mode}:${token}:${conf.nickname?.toLowerCase() ?? ""}:${base}`;
  const cached = idenCache.get(cacheKey);
  if (cached) {
    idenCache.delete(cacheKey);
    idenCache.set(cacheKey, cached);
    return cached;
  }

  if (!conf.nickname) {
    throw new Error(
      `[${conf.mode}] PUSHBULLET_${conf.mode}_DEVICE_IDEN 또는 PUSHBULLET_${conf.mode}_DEVICE_NICKNAME 중 하나는 설정돼야 합니다. ` +
        "(목록 확인: npm run sms:devices)"
    );
  }

  let res: Response;
  try {
    res = await fetchPushbulletWithRetry(`${base}/v2/devices`, {
      headers: { "access-token": token },
    });
  } catch (err: unknown) {
    const errorObj = err as { name?: string; message?: string } | undefined;
    const isTimeout =
      errorObj?.name === "TimeoutError" ||
      errorObj?.name === "AbortError" ||
      errorObj?.message?.toLowerCase().includes("timeout") ||
      errorObj?.message?.toLowerCase().includes("aborted") ||
      errorObj?.message?.includes("시간 초과");
    const wrappedError = new Error(
      `[${conf.mode}] Pushbullet 기기 목록 조회 실패 (${
        isTimeout ? `요청 시간 초과 (${DEFAULT_TIMEOUT_MS}ms)` : err instanceof Error ? err.message : String(err)
      })`
    );
    if (isTimeout) {
      wrappedError.name = "TimeoutError";
    }
    throw wrappedError;
  }

  if (!res.ok) {
    const errorData = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    const msg = errorData?.error?.message || `HTTP ${res.status}`;
    const httpErr: Error & { status?: number; retryAfterSeconds?: number } = new Error(
      `[${conf.mode}] Pushbullet 기기 목록 조회 실패 (${msg})`
    );
    httpErr.status = res.status;
    if (res.status === 429) {
      const retryMs = parsePushbulletRetryMs(res.headers);
      httpErr.retryAfterSeconds = retryMs ? Math.max(1, Math.ceil(retryMs / 1000)) : 5;
    }
    throw httpErr;
  }

  const data = (await res.json().catch(() => ({}))) as {
    devices?: { iden?: string; nickname?: string; active?: boolean }[];
  };
  const match = (data.devices ?? []).find(
    (d) =>
      d.active &&
      d.nickname?.toLowerCase() === conf.nickname!.toLowerCase()
  );
  if (!match?.iden) {
    const available = (data.devices ?? [])
      .filter((d) => d.active)
      .map((d) => d.nickname)
      .join(", ");
    throw new Error(
      `[${conf.mode}] Pushbullet 기기 "${conf.nickname}" 를 찾지 못했습니다. 활성 기기: ${
        available || "(없음)"
      } ` + "(목록 확인: npm run sms:devices)"
    );
  }
  if (idenCache.size >= MAX_IDEN_CACHE_ENTRIES) {
    const oldestKey = idenCache.keys().next().value;
    if (oldestKey !== undefined) idenCache.delete(oldestKey);
  }
  idenCache.set(cacheKey, match.iden);
  return match.iden;
}

export interface PushbulletResult {
  ok: boolean;
  status: number;
  /** iden of the queued text (phone must be online; sends within ~1h or cancels) */
  iden?: string;
  raw?: unknown;
  success?: boolean;
  error?: string;
  retryAfterSeconds?: number;
}

export async function sendViaPushbullet({
  phoneNumber,
  text,
}: {
  phoneNumber: string;
  text: string;
}): Promise<PushbulletResult> {
  try {
    const conf = getPushbulletConfig();
    if (!conf.token) {
      return {
        ok: false,
        success: false,
        status: 400,
        error:
          `[${conf.mode}] PUSHBULLET_${conf.mode}_ACCESS_TOKEN 환경변수가 설정되어야 합니다. ` +
          "(pushbullet.com > Settings > Access Token)",
      };
    }

    const base = process.env.PUSHBULLET_API_URL?.trim() || DEFAULT_API_URL;
    let device: string;
    try {
      device = await resolveDeviceIden(base, conf.token, conf);
    } catch (err: unknown) {
      const errorObj = err as {
        name?: string;
        message?: string;
        status?: number;
        retryAfterSeconds?: number;
      } | undefined;
      const isTimeout =
        errorObj?.name === "TimeoutError" ||
        errorObj?.name === "AbortError" ||
        errorObj?.message?.toLowerCase().includes("timeout") ||
        errorObj?.message?.toLowerCase().includes("aborted") ||
        errorObj?.message?.includes("시간 초과");
      const upstreamStatus =
        typeof errorObj?.status === "number" && errorObj.status >= 400
          ? errorObj.status
          : undefined;
      return {
        ok: false,
        success: false,
        status: isTimeout ? 504 : (upstreamStatus ?? 400),
        error: err instanceof Error ? err.message : String(err),
        ...(typeof errorObj?.retryAfterSeconds === "number"
          ? { retryAfterSeconds: errorObj.retryAfterSeconds }
          : {}),
      };
    }

    const res = await fetchPushbulletWithRetry(`${base}/v2/texts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "access-token": conf.token,
      },
      body: JSON.stringify({
        data: {
          target_device_iden: device,
          addresses: [phoneNumber],
          message: text,
        },
      }),
    });

    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      /* non-JSON body — leave raw undefined */
    }
    const parsed = raw as { iden?: string; error?: { message?: string } } | undefined;

    let errorMessage: string | undefined;
    let retryAfterSeconds: number | undefined;
    if (!res.ok) {
      if (parsed?.error?.message) {
        errorMessage = parsed.error.message;
      } else {
        errorMessage = `Pushbullet API returned HTTP ${res.status}`;
      }
      if (res.status === 429) {
        const retryMs = parsePushbulletRetryMs(res.headers);
        retryAfterSeconds = retryMs ? Math.max(1, Math.ceil(retryMs / 1000)) : 5;
      }
    }

    return {
      ok: res.ok,
      success: res.ok,
      status: res.status,
      iden: parsed?.iden,
      raw,
      ...(errorMessage ? { error: errorMessage } : {}),
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    };
  } catch (err: unknown) {
    const errorObj = err as { name?: string; message?: string } | undefined;
    const isTimeout =
      errorObj?.name === "TimeoutError" ||
      errorObj?.name === "AbortError" ||
      errorObj?.message?.toLowerCase().includes("timeout") ||
      errorObj?.message?.toLowerCase().includes("aborted") ||
      errorObj?.message?.includes("시간 초과");

    const status = isTimeout ? 504 : 500;
    const message = isTimeout
      ? "Pushbullet request timed out (5000ms)"
      : err instanceof Error
        ? err.message
        : String(err);

    return {
      ok: false,
      success: false,
      status,
      error: message,
    };
  }
}
