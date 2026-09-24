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

/** 별명 → iden 해석 결과 캐시 (한 번 실행 중 재조회 방지). */
let cachedIden: string | null = null;

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
  if (cachedIden) return cachedIden;

  if (!conf.nickname) {
    throw new Error(
      `[${conf.mode}] PUSHBULLET_${conf.mode}_DEVICE_IDEN 또는 PUSHBULLET_${conf.mode}_DEVICE_NICKNAME 중 하나는 설정돼야 합니다. ` +
        "(목록 확인: npm run sms:devices)"
    );
  }

  const res = await fetch(`${base}/v2/devices`, {
    headers: { "access-token": token },
  });
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
  cachedIden = match.iden;
  return match.iden;
}

export interface PushbulletResult {
  ok: boolean;
  status: number;
  /** iden of the queued text (phone must be online; sends within ~1h or cancels) */
  iden?: string;
  raw?: unknown;
}

export async function sendViaPushbullet({
  phoneNumber,
  text,
}: {
  phoneNumber: string;
  text: string;
}): Promise<PushbulletResult> {
  const conf = getPushbulletConfig();
  if (!conf.token) {
    throw new Error(
      `[${conf.mode}] PUSHBULLET_${conf.mode}_ACCESS_TOKEN 환경변수가 설정되어야 합니다. ` +
        "(pushbullet.com > Settings > Access Token)"
    );
  }

  const base = process.env.PUSHBULLET_API_URL?.trim() || DEFAULT_API_URL;
  const device = await resolveDeviceIden(base, conf.token, conf);
  const res = await fetch(`${base}/v2/texts`, {
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
  const parsed = raw as { iden?: string } | undefined;
  return { ok: res.ok, status: res.status, iden: parsed?.iden, raw };
}
