import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1DeleteBillingCard = async (app: Elysia<"/v1/billing/card">) => {
  return app.post(
    "/:id",
    async ({ cookie, body, params }) => {
      try {
        const user = await getUser({ cookie, body });

        if (!user) {
          throw new Error("로그인 한 이용자만 사용가능합니다.");
        }

        // 1. 해당 카드가 사용자의 카드인지 확인
        const { data: card, error: cardError } = await supabaseClient
          .from("llami_billing_card")
          .select("*")
          .eq("id", params.id)
          .eq("user_id", user.id)
          .eq("is_deleted", false)
          .limit(1)
          .maybeSingle();

        if (cardError || !card) {
          throw new Error("카드를 찾을 수 없습니다.");
        }

        // 2. 대표 카드인 경우 삭제 불가
        if (card.is_primary) {
          throw new Error("대표 카드는 삭제할 수 없습니다.");
        }

        // 3. 카드 논리적 삭제 처리
        const { error: updateError } = await supabaseClient
          .from("llami_billing_card")
          .update({
            is_deleted: true,
          })
          .eq("id", params.id)
          .eq("user_id", user.id);

        if (updateError) {
          console.error("카드 삭제 실패", updateError);
          throw new Error("카드 삭제에 실패했습니다");
        }

        return {
          success: true,
          message: "카드가 삭제되었습니다",
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
        description: "Delete a billing card",
      },
      params: t.Object({
        id: t.String({
          description: "Card ID",
          error: "Card ID is required",
        }),
      }),
      body: t.Object({
        accessToken: t.Optional(
          t.String({
            description: "Access Token",
            error: "Access Token is required",
          }),
        ),
      }),
      response: t.Object({
        success: t.Boolean(),
        message: t.String(),
      }),
    },
  );
};
