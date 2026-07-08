/**
 * Unified SMS sender — picks the backend via the SMS_PROVIDER env var so the
 * rest of the app stays provider-agnostic:
 *
 *   SMS_PROVIDER=pushbullet → Pushbullet(Play스토어 정식 앱)로 본인 폰이 발송, 0원
 *   SMS_PROVIDER=phone      → 안드로이드 폰 게이트웨이 SMS Gate (APK, 0원, 기본값)
 *   SMS_PROVIDER=solapi     → SOLAPI(구 CoolSMS), 건당 과금
 *
 * All backends are import-safe (no top-level throw), so importing this never
 * crashes boot regardless of which env vars are set.
 */
import { isSolapiConfigured, sendSms as sendViaSolapi } from "./solapi";
import {
  isPhoneGatewayConfigured,
  sendViaPhoneGateway,
} from "./phone-gateway";
import { isPushbulletConfigured, sendViaPushbullet } from "./pushbullet";

export type SmsProvider = "phone" | "solapi" | "pushbullet";

/** Active provider from env. Defaults to the free phone gateway. */
export function activeProvider(): SmsProvider {
  const v = process.env.SMS_PROVIDER?.trim().toLowerCase();
  if (v === "solapi") return "solapi";
  if (v === "pushbullet") return "pushbullet";
  return "phone";
}

/** True when the *active* provider has all its env vars set. */
export function isSmsConfigured(): boolean {
  const provider = activeProvider();
  if (provider === "solapi") return isSolapiConfigured();
  if (provider === "pushbullet") return isPushbulletConfigured();
  return isPhoneGatewayConfigured();
}

export interface SendSmsResult {
  ok: boolean;
  provider: SmsProvider;
  /** Raw provider response (SOLAPI DetailGroupMessageResponse | PhoneGatewayResult). */
  detail: unknown;
}

export async function sendSms({
  phoneNumber,
  text,
}: {
  phoneNumber: string;
  text: string;
}): Promise<SendSmsResult> {
  const provider = activeProvider();
  if (provider === "solapi") {
    const detail = await sendViaSolapi({ phoneNumber, text });
    return { ok: detail.failedMessageList.length === 0, provider, detail };
  }
  if (provider === "pushbullet") {
    const detail = await sendViaPushbullet({ phoneNumber, text });
    return { ok: detail.ok, provider, detail };
  }
  const detail = await sendViaPhoneGateway({ phoneNumber, text });
  return { ok: detail.ok, provider, detail };
}
