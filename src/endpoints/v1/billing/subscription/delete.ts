import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1DeleteBillingSubscription = async (
  app: Elysia<"/v1/billing/subscription">,
) => {
  return app.delete(
    "/:id",
    async ({ cookie, body, params }) => {
      try {
        const user = await getUser({ cookie, body });

        if (!user) {
          throw new Error("로그인 한 이용자만 사용가능합니다.");
        }

        // 1. 구독 정보 확인 및 워크스페이스 권한 체크
        const { data: subscription, error: subscriptionError } =
          await supabaseClient
            .from("llami_subscription")
            .select(`*,llami_workspace (owner)`)
            .eq("id", params.id)
            .eq("is_deleted", false)
            .limit(1)
            .maybeSingle();

        if (subscriptionError || !subscription) {
          throw new Error("구독 정보를 찾을 수 없습니다.");
        }

        if (subscription.llami_workspace.owner !== user.id) {
          throw new Error("워크스페이스 접근 권한이 없습니다.");
        }

        // 2. 구독 취소 처리 (논리적 삭제)
        const { error: updateError } = await supabaseClient
          .from("llami_subscription")
          .update({ is_deleted: true })
          .eq("id", params.id);

        if (updateError) {
          console.error("구독 취소 실패", updateError);
          throw new Error("구독 취소에 실패했습니다");
        }

        return {
          success: true,
          message: "구독이 취소되었습니다",
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
        description: "Cancel subscription",
      },
      params: t.Object({
        id: t.String({
          description: "Subscription ID",
          error: "Subscription ID is required",
        }),
      }),
      body: t.Object({
        accessToken: t.Optional(
          t.String({
            description: "Access Token",
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
