import { SolapiMessageService } from "solapi";

const SOLAPI_API_KEY = process.env.SOLAPI_API_KEY;
const SOLAPI_API_SECRET = process.env.SOLAPI_API_SECRET;

if (!SOLAPI_API_KEY || !SOLAPI_API_SECRET) {
  throw new Error(
    "SOLAPI_API_KEY / SOLAPI_API_SECRET 환경변수가 설정되어야 합니다.",
  );
}

/**
 * SMS 전송 서비스 인스턴스
 */
export const solapiMessageService = new SolapiMessageService(
  SOLAPI_API_KEY,
  SOLAPI_API_SECRET,
);

/**
 * 솔라피 전송용 관리자 전화번호
 * (사전에 솔라피에서 허가된 전화번호로만 SMS 전송이 가능합니다.)
 */
export const solapiAdminPhoneNumber = process.env.SOLAPI_ADMIN_PHONE_NUMBER;

/**
 * 기본 카카오 비즈니스 채널 ID (솔라피에선 pfId 로 사용됨)
 */
export const kakaoBusinessChannelId =
  process.env.KAKAO_BUSINESS_CHANNEL_ID;

if (!solapiAdminPhoneNumber || !kakaoBusinessChannelId) {
  throw new Error(
    "SOLAPI_ADMIN_PHONE_NUMBER / KAKAO_BUSINESS_CHANNEL_ID 환경변수가 설정되어야 합니다.",
  );
}

export const sendSms = async ({
  phoneNumber,
  text,
}: {
  phoneNumber: string;
  text: string;
}) => {
  return await solapiMessageService.send({
    to: phoneNumber,
    from: solapiAdminPhoneNumber,
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
  await solapiMessageService.send({
    to: phoneNumber,
    from: solapiAdminPhoneNumber,
    kakaoOptions: {
      pfId: pfId ?? kakaoBusinessChannelId,
      templateId,
      // * 치환문구가 없을 때의 기본 형태
      variables,
      // * disbaleSms 값을 true로 줄 경우 문자로의 대체발송이 비활성화 됩니다.
      disableSms: disableSms ?? false,
    },
  });
};
