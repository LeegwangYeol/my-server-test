import { Cookie, Elysia, t } from "elysia";
import { supabaseClient } from "@/lib/supabase/client";
import { parsePhoneNumber } from "@/src/utils/parse-phone-number";
import { sendPrimaryDiscordWebhook } from "@/src/utils/log/discord-logger";
import { createJwt } from "@/lib/jwt";

export const v1AccountOtpCheck = async (app: Elysia<"/v1/account">) => {
  app.post(
    "/otp/check",
    async ({
      body: { phoneNumber: _phoneNumber, otpNumber: _otpNumber },
      request,
      cookie: { accessToken },
    }) => {
      const phoneNumber = parsePhoneNumber(_phoneNumber);
      const otpNumber = Number(_otpNumber);

      // phone_otp 테이블에서 확인
      const { data: otpData } = await supabaseClient
        .from("phone_otp")
        .select("*")
        .eq("phone_number", phoneNumber)
        .limit(1)
        .maybeSingle();

      if (!otpData) {
        return {
          success: false,
          message: "인증번호를 먼저 발송해주세요.",
        };
      }

      // @TODO 만료시간 체크 (10분)
      const expireTime = new Date(otpData.updated_at);
      expireTime.setMinutes(expireTime.getMinutes() + 10);

      if (new Date() > expireTime) {
        return {
          success: false,
          message: "인증번호가 만료되었습니다.",
        };
      }

      // OTP 번호 일치 확인
      if (otpNumber !== otpData.otp_number) {
        return {
          success: false,
          message: "인증번호가 일치하지 않습니다.",
        };
      }

      // 기존 유저 확인
      const { data: existingUser } = await supabaseClient
        .from("user")
        .select("*")
        .eq("phone_number", phoneNumber)
        .limit(1)
        .maybeSingle();

      let user = existingUser;

      // 기존 유저가 없는 경우에만 새로 생성
      if (!existingUser) {
        const { data: newUser, error: userError } = await supabaseClient
          .from("user")
          .insert({ phone_number: phoneNumber })
          .select()
          .limit(1)
          .maybeSingle();

        if (userError || !newUser) {
          console.error(userError);
          return {
            success: false,
            message: "회원가입 처리 중 오류가 발생했습니다.",
          };
        }

        user = newUser;

        // 신규 가입시에만 디스코드 웹훅 발송
        sendPrimaryDiscordWebhook(
          `🔖 회원가입이 발생하였습니다.\n> ${phoneNumber} 님이 회원가입하셨습니다.`,
          request,
        );
      }

      if (!user) {
        return {
          success: false,
          message: "회원가입 처리 중 오류가 발생했습니다.",
        };
      }

      // * 유저가 속해있는 조직이 1개라도 있는지 확인
      const { data: workspace } = await supabaseClient
        .from("llami_workspace")
        .select("*")
        .eq("owner", user.id)
        .eq("is_deleted", false)
        .limit(1)
        .maybeSingle();

      // * 유저가 속한 조직이 없는 경우, 개인계정 조직 생성
      if (!workspace) {
        sendPrimaryDiscordWebhook(
          `🔖 신규 이용자 가입으로 인해 조직이 생성되었습니다.\n> **${phoneNumber}** 님의 "개인계정" 조직이 생성되었습니다.\n 유저 UUID: **${user.id}**`,
          request,
        );
        // * 워크스페이스 생성
        const { data: workspace, error } = await supabaseClient
          .from("llami_workspace")
          .insert({
            owner: user.id,
            name: "개인계정",
            is_deleted: false,
          })
          .select("*")
          .limit(1)
          .maybeSingle();

        {
          // * 워크스페이스 생성 예외처리
          if (error) {
            console.error(error);
            throw new Error(
              "네트워크 오류로 인해 문제가 발생했습니다. 잠시 후 다시 시도해주세요, 문제가 지속되면 관리자에게 문의해주세요.",
            );
          }
          if (!workspace) {
            throw new Error(
              "네트워크 오류로 인해 문제가 발생했습니다. 잠시 후 다시 시도해주세요, 문제가 지속되면 관리자에게 문의해주세요.",
            );
          }
        }

        // * 워크스페이스 제한 생성
        await supabaseClient.from("llami_workspace_usage_limit").insert({
          workspace_id: workspace.id,
          refresh_usage_count: 20,
          special_usage_count: 0,
          has_usage_alert_sent: false,
          usage_alert_count: 4,
        });
      }

      const token = createJwt({ userId: user.id });
      setAccessTokenCookie(accessToken, token!, request, {
        secure: true,
        httpOnly: false,
      });

      return {
        success: true,
        message: "회원가입이 완료되었습니다.",
        token,
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
        otpNumber: t.String({
          description: "OTP number",
          error: "OTP number is required",
        }),
      }),
    },
  );
};

export type IAccessTokenOptions = {
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "strict" | "lax" | "none";
  path?: string;
};

// 액세스 토큰 쿠키 설정 함수
export function setAccessTokenCookie(
  accessToken: Cookie<string | undefined>,
  token: string,
  request: Request,
  accessTokenOpt?: IAccessTokenOptions,
): void {
  // Origin 헤더에서 도메인 추출
  const origin = request.headers.get("origin") ?? "https://llami.net";
  let clientDomain: string;

  try {
    clientDomain = new URL(origin).hostname;
  } catch (error) {
    // URL 파싱 실패 시 기본 도메인 사용
    clientDomain = "llami.net";
  }

  const defaultOptions = {
    domain: clientDomain,
    sameSite: "strict" as const,
    secure: true,
    httpOnly: false,
    maxAge: 60 * 60 * 24 * 365, // 1년
    expires: new Date(Date.now() + 60 * 60 * 24 * 365), // 1년 후
    path: "/",
  };

  const options = { ...defaultOptions, ...accessTokenOpt, value: token };
  accessToken.set(options);
}
