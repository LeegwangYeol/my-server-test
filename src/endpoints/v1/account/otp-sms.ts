import { Elysia, t } from "elysia";
import { supabaseClient } from "@/lib/supabase/client";
import { sendKakaoMessage, sendSms } from "@/lib/sms/solapi";
import { validatePhoneNumber } from "@/src/utils/validate-phone-number";
import { parsePhoneNumber } from "@/src/utils/parse-phone-number";
import { generateOtpCode } from "@/src/utils/otp-code-generator";
import { formatSupabaseDate } from "@/src/utils/format-supabase-date";

export const v1AccountOtpSms = async (app: Elysia<"/v1/account">) => {
  app.post(
    "/otp/sms",
    async ({ body: { phoneNumber: _phoneNumber } }) => {
      // 전화번호 형식 검증
      if (!validatePhoneNumber(_phoneNumber)) {
        return {
          success: false,
          message: "전화번호 형식이 잘못되었습니다.",
        };
      }

      const phoneNumber = parsePhoneNumber(_phoneNumber);

      // * OTP 데이터 확인
      const { data: otpData } = await supabaseClient
        .from("phone_otp")
        .select("*")
        .eq("phone_number", phoneNumber)
        .limit(1)
        .maybeSingle();

      // * OTP 데이터가 존재하고, 10초 이내에 발송한 경우
      if (otpData) {
        const currentTime = new Date().getTime();
        const updatedAt = new Date(otpData.updated_at).getTime();
        const diff = Math.abs(currentTime - updatedAt);
        if (diff < 5000) {
          throw new Error(
            "이미 인증번호를 발송했습니다. 잠시 후 다시 시도해주세요.",
          );
        }
      }

      // OTP 생성
      let otpCode = generateOtpCode();

      // * 테스트용 코드
      if (phoneNumber === "+829911111111" || phoneNumber === "+829911223344")
        otpCode = 345678;

      // phone_otp 테이블에 저장/업데이트
      const { error } = await supabaseClient.from("phone_otp").upsert({
        phone_number: phoneNumber,
        otp_number: otpCode,
        updated_at: formatSupabaseDate(new Date()),
      });

      if (error) {
        console.error("인증 오류", error);
        return {
          success: false,
          message:
            "인증번호 발급에 실패했습니다. 잠시 후 다시 시도해주세요. 문제가 지속될 경우 고객센터(contact@llami.net)로 문의해주세요.",
        };
      }

      // SMS 발송
      if (!phoneNumber.startsWith("+8299")) {
        try {
          const currentMode = "sms";

          if (currentMode === "sms") {
            // * 문자 발송
            await sendSms({
              phoneNumber,
              text: `(LLAMI) 본인인증번호 [${otpCode}]를 입력해주세요.\n'타인 노출 금지' llami.net`,
            });
          } else if (currentMode === "kakao") {
            // * 카톡채널톡 발송코드 지우면 안됩니다.
            await sendKakaoMessage({
              phoneNumber,
              variables: {
                "#{name}": "안녕하세요!!",
                "#{code}": `인증번호 [${otpCode}] - 라미 인증번호입니다. (llami.net)`,
              },
              templateId: "KA01TP240605030730822rcUugkAm6Rw",
            });
          }
        } catch (error) {
          console.error(error);
          return {
            success: false,
            message:
              "SMS 발송에 실패했습니다. 잠시 후 다시 시도해주세요. 문제가 지속될 경우 고객센터(contact@llami.net)로 문의해주세요.",
          };
        }
      }

      return {
        success: true,
        message: "인증번호가 발송되었습니다.",
      };
    },
    {
      body: t.Object({
        phoneNumber: t.String({
          description: "User phone number",
          error: "Phone number is required",
          minLength: 11,
          maxLength: 20,
        }),
      }),
    },
  );
};
