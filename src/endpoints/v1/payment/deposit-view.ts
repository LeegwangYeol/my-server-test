import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1PaymentDepositView = async (app: Elysia<"/v1/payment">) => {
  app.post(
    "/deposit/view",
    async ({ body, cookie }) => {
      const user = await getUser({ body, cookie });
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능합니다.",
        };
      }

      // * 예치금 정보 확인
      const { data: deposit } = await supabaseClient
        .from("llami_deposit")
        .select("*")
        .eq("user", user.id)
        .limit(1)
        .maybeSingle();

      // * 예치금 정보가 없을 경우
      if (!deposit) {
        return {
          success: false,
          message: "예치금 정보가 없습니다.",
        };
      }

      return {
        success: true,
        message: "예치금 정보 조회 성공",
        deposit,
      };
    },
    {
      detail: {
        tags: ["Payment"],
        description: "Deposit view",
      },
      body: t.Object({
        accessToken: t.Optional(
          t.String({
            description: "Access Token",
            error: "Access Token is required",
          }),
        ),
      }),
      response: t.Object({
        success: t.Boolean({
          description: "Success",
          error: "Success is required",
        }),
        message: t.Optional(
          t.String({
            description: "Message",
            error: "Message is required",
            minLength: 1,
            maxLength: 1000,
          }),
        ),
        deposit: t.Optional(t.Any({})),
      }),
    },
  );
};
