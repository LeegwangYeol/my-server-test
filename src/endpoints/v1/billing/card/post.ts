import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import Elysia, { t } from "elysia";
import { TOSS_PAYMENTS_SECRET_KEY } from "@/lib/config";

export const v1PostBillingCard = async (app: Elysia<"/v1/billing/card">) => {
  return app.post(
    "/",
    async ({ cookie, body }) => {
      try {
        const user = await getUser({ cookie, body });
        if (!user) throw new Error("로그인 한 이용자만 사용가능합니다.");

        if (!TOSS_PAYMENTS_SECRET_KEY)
          throw new Error("토스페이먼츠 시크릿 키가 설정되지 않았습니다.");

        // 토스페이먼츠 빌링키 발급 요청
        const response = await fetch(
          "https://api.tosspayments.com/v1/billing/authorizations/issue",
          {
            method: "POST",
            headers: {
              Authorization: `Basic ${Buffer.from(
                TOSS_PAYMENTS_SECRET_KEY + ":",
              ).toString("base64")}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              authKey: body.authKey,
              customerKey: user.id,
            }),
          },
        );

        const result = await response.json();

        if (!response.ok) {
          console.error("빌링키 발급 실패", result);
          throw new Error("카드 등록에 실패했습니다");
        }

        // 카드 정보 저장
        const { error } = await supabaseClient
          .from("llami_billing_card")
          .insert({
            user_id: user.id,
            billing_key: result.billingKey,
            company_code: result.card.issuerCode,
            card_company: result.cardCompany,
            card_number: result.card.number,
            card_type: result.card.cardType,
            owner_type: result.card.ownerType,
            is_primary: false,
            is_deleted: false,
          });

        if (error) {
          console.error("카드 정보 저장 실패", error);
          throw new Error("카드 정보 저장에 실패했습니다");
        }

        return {
          success: true,
          message: "카드가 성공적으로 등록되었습니다",
        };
      } catch (error) {
        return {
          success: false,
          message: (error as Error).message,
        };
      }
    },
    {
      detail: {
        tags: ["Billing"],
        description: "Register a new card and get billing key",
      },
      body: t.Object({
        authKey: t.String({
          description: "Toss Payments auth key",
          error: "Auth key is required",
        }),
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
        message: t.String({
          description: "Response message",
          error: "Message is required",
          minLength: 1,
          maxLength: 1000,
        }),
      }),
    },
  );
};
