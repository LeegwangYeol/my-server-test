import { Elysia, t } from "elysia";
import { supabaseClient } from "@/lib/supabase/client";
import { sendKakaoMessage, sendSms } from "@/lib/sms/solapi";
import { parsePhoneNumber } from "@/src/utils/parse-phone-number";

export interface OTPData {
  user_id: string;
  otp_number: string | null;
  updated_at: string | null;
}

export const v1SendMessage = async (app: Elysia<"/v1/authorized">) => {
  app.post(
    "/send/message",
    async ({ body: { phoneNumber: _phoneNumber } }) => {
      const phoneNumber = parsePhoneNumber(_phoneNumber);

      try {
        await supabaseClient.from("llami_authorized_customer").upsert({
          phone_number: phoneNumber,
        });

        const { data: user } = await supabaseClient
          .from("llami_authorized_customer")
          .select("*")
          .limit(1)
          .maybeSingle();

        if (!user) {
          throw new Error("사용자 정보 생성 실패");
        }

        // OTP 생성 및 발송
        const otpCode = Math.floor(100000 + Math.random() * (999999 - 100000));
        await sendSms({
          phoneNumber,
          text: `(LLAMI) 본인인증번호 [${otpCode}]를 입력해주세요.\n'타인 노출 금지' llami.net`,
        });

        // OTP 정보 업데이트
        await supabaseClient.from("llami_customer_otp").upsert({
          otp_number: `${otpCode}`,
          user_id: user.id,
        });

        return { success: true };
      } catch (error) {
        console.error(error);
      }
    },
    {
      detail: {
        tags: ["Authorized"],
        description: "send message to authorized user",
      },
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
