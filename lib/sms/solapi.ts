import { SolapiMessageService } from "solapi";

/**
 * SOLAPI(구 CoolSMS) 문자/알림톡 발송 모듈.
 *
 * 환경변수:
 *   SOLAPI_API_KEY           SOLAPI API 키
 *   SOLAPI_API_SECRET        SOLAPI API 시크릿
 *   SOLAPI_ADMIN_PHONE_NUMBER 발신번호 — SOLAPI 콘솔에 사전 등록/인증된 번호여야
 *                            발송됩니다(아무 번호나 못 씀).
 *   KAKAO_BUSINESS_CHANNEL_ID 카카오 알림톡 채널 ID(SOLAPI에선 pfId) — 알림톡을
 *                            보낼 때만 필요. 일반 문자에는 불필요.
 *
 * 서비스 인스턴스는 첫 발송 시점에 지연 생성되므로, 이 모듈을 import하는 것만으로는
 * 절대 throw하지 않습니다 — 위젯/메일 등 다른 기능은 SMS env가 없어도 정상 부팅돼야
 * 하기 때문입니다(lib/mail/naver.ts 와 동일한 원칙).
 */

let cached: SolapiMessageService | null = null;

function getService(): SolapiMessageService {
  if (cached) return cached;
  const apiKey = process.env.SOLAPI_API_KEY?.trim();
  const apiSecret = process.env.SOLAPI_API_SECRET?.trim();
  if (!apiKey || !apiSecret) {
    throw new Error(
      "SOLAPI_API_KEY / SOLAPI_API_SECRET 환경변수가 설정되어야 합니다.",
    );
  }
  cached = new SolapiMessageService(apiKey, apiSecret);
  return cached;
}

/**
 * 솔라피 전송용 관리자(발신) 전화번호.
 * (사전에 솔라피에서 허가된 전화번호로만 발송이 가능합니다.)
 */
export const solapiAdminPhoneNumber = process.env.SOLAPI_ADMIN_PHONE_NUMBER;

/**
 * 기본 카카오 비즈니스 채널 ID (솔라피에선 pfId 로 사용됨)
 */
export const kakaoBusinessChannelId = process.env.KAKAO_BUSINESS_CHANNEL_ID;

/**
 * 일반 문자(SMS/LMS) 발송에 필요한 env(키/시크릿/발신번호)가 모두 있는지.
 * 카카오 알림톡은 추가로 KAKAO_BUSINESS_CHANNEL_ID 가 필요합니다.
 */
export function isSolapiConfigured(): boolean {
  return Boolean(
    process.env.SOLAPI_API_KEY?.trim() &&
      process.env.SOLAPI_API_SECRET?.trim() &&
      process.env.SOLAPI_ADMIN_PHONE_NUMBER?.trim(),
  );
}

export const sendSms = async ({
  phoneNumber,
  text,
}: {
  phoneNumber: string;
  text: string;
}) => {
  const from = process.env.SOLAPI_ADMIN_PHONE_NUMBER?.trim();
  if (!from) {
    throw new Error(
      "SOLAPI_ADMIN_PHONE_NUMBER 환경변수가 설정되어야 합니다. " +
        "(SOLAPI 콘솔에 사전 등록된 발신번호)",
    );
  }
  return await getService().send({
    to: phoneNumber,
    from,
    text,
  });
};

/**
 * 카카오톡 메시지 전송
 * @param phoneNumber 수신자 전화번호
 * @param pfId 카카오톡 채널 ID
 * @param templateId 카카오톡 템플릿 ID
 * @param variables 카카오톡 템플릿 변수
 * @param disableSms 카카오 알림톡 발송 실패시 문자로의 대체발송 비활성화 여부 (기본값: false)
 */
export const sendKakaoMessage = async ({
  phoneNumber,
  pfId,
  templateId,
  variables,
  disableSms,
}: {
  phoneNumber: string;
  pfId?: string;
  templateId?: string;
  variables: Record<string, string>;
  disableSms?: boolean;
}) => {
  const from = process.env.SOLAPI_ADMIN_PHONE_NUMBER?.trim();
  if (!from) {
    throw new Error(
      "SOLAPI_ADMIN_PHONE_NUMBER 환경변수가 설정되어야 합니다. " +
        "(SOLAPI 콘솔에 사전 등록된 발신번호)",
    );
  }
  const channelId = pfId ?? process.env.KAKAO_BUSINESS_CHANNEL_ID?.trim();
  if (!channelId) {
    throw new Error(
      "KAKAO_BUSINESS_CHANNEL_ID 환경변수(또는 pfId 인자)가 설정되어야 합니다.",
    );
  }
  await getService().send({
    to: phoneNumber,
    from,
    kakaoOptions: {
      pfId: channelId,
      templateId,
      // * 치환문구가 없을 때의 기본 형태
      variables,
      // * disableSms 값을 true로 줄 경우 문자로의 대체발송이 비활성화 됩니다.
      disableSms: disableSms ?? false,
    },
  });
};
