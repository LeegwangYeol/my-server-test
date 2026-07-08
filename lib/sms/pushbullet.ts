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
 *   PUSHBULLET_DEVICE_IDEN   the Android phone's device iden
 *                            (GET /v2/devices, or the URL when the device is
 *                            selected on pushbullet.com)
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
      process.env.PUSHBULLET_DEVICE_IDEN?.trim(),
  );
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
  const device = process.env.PUSHBULLET_DEVICE_IDEN?.trim();
  if (!token || !device) {
    throw new Error(
      "PUSHBULLET_ACCESS_TOKEN / PUSHBULLET_DEVICE_IDEN 환경변수가 설정되어야 합니다. " +
        "(pushbullet.com > Settings > Access Token, 폰의 device iden)",
    );
  }

  const base = process.env.PUSHBULLET_API_URL?.trim() || DEFAULT_API_URL;
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
