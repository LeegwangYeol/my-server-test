/**
 * Unified SMS sender — picks the backend via the SMS_PROVIDER env var so the
 * rest of the app stays provider-agnostic:
 *
 *   SMS_PROVIDER=pushbullet → Pushbullet(Play스토어 정식 앱)로 본인 폰이 발송, 0원
 *   SMS_PROVIDER=phone      → 안드로이드 폰 게이트웨이 SMS Gate (APK, 0원, 기본값)
 *
 * NOTE: SOLAPI(구 CoolSMS) 백엔드는 제거됨 — 해당 계정이 회사 자산이라
 * 개인 프로젝트에서 쓰면 안 되기 때문(크레딧 소진/책임 리스크). 유료 문자가
 * 필요하면 본인 명의 계정으로 새 백엔드를 추가할 것.
 *
 * All backends are import-safe (no top-level throw), so importing this never
 * crashes boot regardless of which env vars are set.
 */
import {
  isPhoneGatewayConfigured,
  sendViaPhoneGateway,
} from "./phone-gateway";
import { isPushbulletConfigured, sendViaPushbullet } from "./pushbullet";

export type SmsProvider = "phone" | "pushbullet";

/** Active provider from env. Defaults to the free phone gateway. */
export function activeProvider(): SmsProvider {
  const v = process.env.SMS_PROVIDER?.trim().toLowerCase();
  if (v === "pushbullet") return "pushbullet";
  // "solapi" 를 포함한 그 외 값은 전부 무료 phone gateway 로 폴백한다.
  return "phone";
}

/** True when the *active* provider has all its env vars set. */
export function isSmsConfigured(): boolean {
  const provider = activeProvider();
  if (provider === "pushbullet") return isPushbulletConfigured();
  return isPhoneGatewayConfigured();
}

export interface SendSmsResult {
  ok: boolean;
  provider: SmsProvider;
  /** Raw provider response (PushbulletResult | PhoneGatewayResult). */
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
  if (provider === "pushbullet") {
    const detail = await sendViaPushbullet({ phoneNumber, text });
    return { ok: detail.ok, provider, detail };
  }
  const detail = await sendViaPhoneGateway({ phoneNumber, text });
  return { ok: detail.ok, provider, detail };
}
