/**
 * Unified SMS sender — SMS_PROVIDER 로 백엔드를 고른다.
 *
 *   SMS_PROVIDER=pushbullet → Pushbullet REST API (HTTPS 뿐이라 **서버에서 동작**). 기본값.
 *   SMS_PROVIDER=imessage   → 맥 Messages + 아이폰 문자전달 (osascript) — **맥 로컬 전용**
 *   SMS_PROVIDER=phone      → SMS Gate 안드로이드 게이트웨이 (집 LAN 접근) — **맥 로컬 전용**
 *
 * 세 경로 모두 살아 있다. 다만 맥 전용 두 경로의 **구현체는 test/sms-local/ 에 있다** —
 * osascript·chat.db·로컬 LAN 접근은 Vercel 서버리스에서 원리적으로 불가하고, 서버 번들
 * (api/index.js)에 끌어들이면 배포만 무거워지기 때문이다.
 *
 * 그래서 이 파일(서버 진입점)은 맥 전용 경로를 **import 하지 않고**, 호출되면 어디로 가야
 * 하는지 알려준다. 로컬에서 세 경로를 모두 쓰는 곳은 test/sms-local/send-greetings.ts 이며,
 * 거기서는 구현체를 직접 import 하므로 셋 다 정상 동작한다.
 *
 * NOTE: SOLAPI(구 CoolSMS) 백엔드는 제거됨 — 해당 계정이 회사 자산이라
 * 개인 프로젝트에서 쓰면 안 되기 때문(크레딧 소진/책임 리스크). 유료 문자가
 * 필요하면 본인 명의 계정으로 새 백엔드를 추가할 것.
 *
 * import-safe: 모듈 로드 시 throw 하지 않으므로, env 가 비어 있어도 부팅은 멀쩡하다.
 */
import { isPushbulletConfigured, sendViaPushbullet } from "./pushbullet";

export type SmsProvider = "pushbullet" | "imessage" | "phone";

/** 서버 번들에서는 실행 불가능한 경로들 (구현체는 test/sms-local/). */
const LOCAL_ONLY: Record<string, string> = {
  imessage: "test/sms-local/imessage.ts (osascript — macOS 필요)",
  phone: "test/sms-local/phone-gateway.ts (SMS Gate — 집 LAN 접근 필요)",
};

export function activeProvider(): SmsProvider {
  const v = process.env.SMS_PROVIDER?.trim().toLowerCase();
  if (v === "imessage") return "imessage";
  if (v === "phone") return "phone";
  return "pushbullet";
}

/** True when the active provider is usable **from the server**. */
export function isSmsConfigured(): boolean {
  const provider = activeProvider();
  if (provider in LOCAL_ONLY) return false; // 서버에서는 못 씀
  return isPushbulletConfigured();
}

export interface SendSmsResult {
  ok: boolean;
  provider: SmsProvider;
  /** Raw provider response (PushbulletResult). */
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
  const localOnly = LOCAL_ONLY[provider];
  if (localOnly) {
    throw new Error(
      `SMS_PROVIDER=${provider} 는 맥 로컬 전용이라 서버에서 실행할 수 없습니다. ` +
        `구현체: ${localOnly}. 일괄 발송은 로컬에서 npm run greetings 를 쓰고, ` +
        "서버에서 보내야 하면 SMS_PROVIDER=pushbullet 을 쓰세요.",
    );
  }
  const detail = await sendViaPushbullet({ phoneNumber, text });
  return { ok: detail.ok, provider, detail };
}
