import { t } from "elysia";
import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import Elysia from "elysia";

export const v1PostBillingCardList = async (
  app: Elysia<"/v1/billing/card">,
) => {
  return app.post(
    "/list",
    async ({ cookie, body }) => {
      try {
        const user = await getUser({ cookie, body });

        if (!user) {
          throw new Error("로그인 한 이용자만 사용가능합니다.");
        }

        const { data: cards, error } = await supabaseClient
          .from("llami_billing_card")
          .select("*")
          .eq("user_id", user.id)
          .eq("is_deleted", false)
          .order("created_at", { ascending: false });

        if (error) {
          console.error("카드 목록 조회 실패", error);
          throw new Error("카드 목록 조회에 실패했습니다");
        }

        const sanitizedCards = cards.map((card) => ({
          id: card.id,
          card_company: card.card_company,
          card_number: card.card_number, // 이미 마스킹된 상태
          card_type: card.card_type,
          owner_type: card.owner_type,
          is_primary: card.is_primary,
          created_at: card.created_at,
          is_working: card.is_working,
        }));

        return {
          success: true,
          data: { cards: sanitizedCards },
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
        description: "Get card information",
      },
      body: t.Object({
        accessToken: t.Optional(t.String()),
      }),
      response: t.Object({
        success: t.Boolean(),
        message: t.Optional(t.String()),
        data: t.Optional(
          t.Object({
            cards: t.Array(
              t.Object({
                id: t.String(),
                card_company: t.String(),
                card_number: t.String(),
                card_type: t.String(),
                owner_type: t.String(),
                is_primary: t.Boolean(),
                created_at: t.String(),
                is_working: t.Boolean(),
              }),
            ),
          }),
        ),
      }),
    },
  );
};
