import { Elysia, t } from "elysia";
import { supabaseClient } from "@/lib/supabase/client";
import { parsePhoneNumber } from "@/src/utils/parse-phone-number";

export const v1AuthorizedMessage = async (app: Elysia<"/v1/authorized">) => {
  app.post(
    "/message/authorized/",
    async ({
      body: { phoneNumber: _phoneNumber, otpNumber, threadId },
      request,
    }) => {
      const phoneNumber = parsePhoneNumber(_phoneNumber);

      validateOtpNumber(otpNumber);

      const userData = await getUserData(phoneNumber);
      await verifyOtpData(userData.id, otpNumber);

      //LLAMI_AUTHORIZED_THREAD 테이블에 저장
      await supabaseClient.from("llami_authorized_thread").insert({
        id: threadId,
        user_id: userData.id,
      });

      return { success: true };
    },
    {
      detail: {
        tags: ["Authorized"],
        description: "message authorized user",
      },
      body: t.Object({
        otpNumber: t.String({
          description: "OTP number",
          error: "OTP number is required",
          minLength: 1,
          maxLength: 6,
        }),
        phoneNumber: t.String({
          description: "User phone number",
          error: "Phone number is required",
          minLength: 11,
          maxLength: 20,
        }),
        threadId: t.String({
          description: "Thread ID",
          error: "Thread ID is required",
        }),
      }),
    },
  );
};

// OTP 번호 유효성 검사 함수
const validateOtpNumber = (otpNumber: string): void => {
  if (otpNumber.length !== 6) throw new Error("OTP번호는 6자리여야 합니다.");
};

// 사용자 데이터 조회 함수
const getUserData = async (phoneNumber: string) => {
  const { data: userData } = await supabaseClient
    .from("llami_authorized_customer")
    .select("*")
    .eq("phone_number", phoneNumber)
    .limit(1)
    .maybeSingle();

  if (!userData) {
    throw new Error("사용자 정보가 없습니다.");
  }

  return userData;
};

// OTP 데이터 검증 함수
async function verifyOtpData(userId: string, otpNumber: string): Promise<void> {
  const { data: otpData } = await supabaseClient
    .from("llami_customer_otp")
    .select("*")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  if (!otpData) throw new Error("OTP 정보가 없습니다.");
  if (otpNumber !== otpData.otp_number)
    throw new Error("OTP번호가 일치하지 않습니다.");
}
