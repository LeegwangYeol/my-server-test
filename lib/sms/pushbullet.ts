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
 *   PUSHBULLET_ACCESS_TOKEN  Settings > Account > Create Access Token
 *   PUSHBULLET_DEVICE_IDEN   보낼 안드로이드폰의 device iden (가장 확실)
 *   PUSHBULLET_DEVICE_NICKNAME
 *                            iden 대신 **폰 별명**으로 지정 (예: "가족 갤럭시").
 *                            폰을 갈아끼울 때 iden 을 찾을 필요 없이 이 한 줄만 바꾸면 된다.
 *                            IDEN 이 있으면 IDEN 이 우선. 조회: npm run sms:devices
 *   PUSHBULLET_API_URL       optional override, for tests. Default official.
 *
 * Import-safe: never throws at module load (mirrors lib/sms/phone-gateway.ts).
 * No relative imports on purpose — scripts run this file directly under
 * `node --env-file`, whose ESM resolver needs explicit extensions.
 */

const DEFAULT_API_URL = "https://api.pushbullet.com";

export function isPushbulletConfigured(): boolean {
  return Boolean(
    process.env.PUSHBULLET_ACCESS_TOKEN?.trim() &&
      (process.env.PUSHBULLET_DEVICE_IDEN?.trim() ||
        process.env.PUSHBULLET_DEVICE_NICKNAME?.trim()),
  );
}

/** 별명 → iden 해석 결과 캐시 (한 번 실행 중 재조회 방지). */
let cachedIden: string | null = null;

/**
 * 보낼 기기의 iden 을 정한다.
 * IDEN 이 지정돼 있으면 그대로, 아니면 NICKNAME 으로 /v2/devices 에서 찾는다.
 */
async function resolveDeviceIden(base: string, token: string): Promise<string> {
  const explicit = process.env.PUSHBULLET_DEVICE_IDEN?.trim();
  if (explicit) return explicit;
  if (cachedIden) return cachedIden;

  const nickname = process.env.PUSHBULLET_DEVICE_NICKNAME?.trim();
  if (!nickname) {
    throw new Error(
      "PUSHBULLET_DEVICE_IDEN 또는 PUSHBULLET_DEVICE_NICKNAME 중 하나는 설정돼야 합니다. " +
        "(목록 확인: npm run sms:devices)",
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
      d.active && d.nickname?.toLowerCase() === nickname.toLowerCase(),
  );
  if (!match?.iden) {
    const available = (data.devices ?? [])
      .filter((d) => d.active)
      .map((d) => d.nickname)
      .join(", ");
    throw new Error(
      `Pushbullet 기기 "${nickname}" 를 찾지 못했습니다. 활성 기기: ${available || "(없음)"} ` +
        "(목록 확인: npm run sms:devices)",
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
  const token = process.env.PUSHBULLET_ACCESS_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "PUSHBULLET_ACCESS_TOKEN 환경변수가 설정되어야 합니다. " +
        "(pushbullet.com > Settings > Access Token)",
    );
  }

  const base = process.env.PUSHBULLET_API_URL?.trim() || DEFAULT_API_URL;
  const device = await resolveDeviceIden(base, token);
  const res = await fetch(`${base}/v2/texts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "access-token": token,
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
