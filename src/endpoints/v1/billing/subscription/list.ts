import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1PostBillingSubscriptionList = async (
  app: Elysia<"/v1/billing/subscription">,
) => {
  return app.post(
    "/list",
    async ({ cookie, body }) => {
      try {
        const user = await getUser({ cookie, body });

        if (!user) {
          throw new Error("로그인 한 이용자만 사용가능합니다.");
        }

        const { data: workspace, error: workspaceError } = await supabaseClient
          .from("llami_workspace")
          .select("*")
          .eq("id", body.workspaceId)
          .eq("owner", user.id)
          .limit(1)
          .maybeSingle();

        if (workspaceError || !workspace) {
          throw new Error("워크스페이스 접근 권한이 없습니다.");
        }

        const { data: subscription, error: subscriptionError } =
          await supabaseClient
            .from("llami_subscription")
            .select(
              `
            *,
            llami_billing_card (
              card_company,
              card_number,
              card_type,
              owner_type
            ),
            llami_product (
              name,
              display_name,
              usage_limit,
              amount,
              currency
            ),
            llami_workspace (
              name,
              owner
            )
          `,
            )
            .eq("workspace_id", body.workspaceId)
            .eq("is_deleted", false)
            .limit(1)
            .maybeSingle();

        if (subscriptionError) {
          console.error("구독 정보 조회 실패", subscriptionError);
          throw new Error("구독 정보 조회에 실패했습니다");
        }

        if (!subscription) {
          console.error("구독 정보 누락");
          throw new Error("구독 정보를 찾을 수 없습니다");
        }

        if (!subscription.llami_billing_card) {
          console.error("카드 정보 누락", subscription.id);
          throw new Error("구독에 연결된 카드 정보를 찾을 수 없습니다");
        }

        if (!subscription.llami_product) {
          console.error("상품 정보 누락", subscription.id);
          throw new Error("구독에 연결된 상품 정보를 찾을 수 없습니다");
        }

        return {
          success: true,
          data: {
            id: subscription.id,
            created_at: subscription.created_at,
            updated_at: subscription.updated_at,
            workspace: {
              id: subscription.workspace_id,
              name: subscription.llami_workspace.name,
              owner: subscription.llami_workspace.owner,
            },
            card: {
              company: subscription.llami_billing_card.card_company,
              number: subscription.llami_billing_card.card_number,
              type: subscription.llami_billing_card.card_type,
              owner_type: subscription.llami_billing_card.owner_type,
            },
            product: {
              name: subscription.llami_product.name,
              display_name: subscription.llami_product.display_name,
              usage_limit: subscription.llami_product.usage_limit,
              amount: subscription.llami_product.amount,
              currency: subscription.llami_product.currency,
            },
          },
          message: "구독 정보를 조회했습니다",
        };
      } catch (error) {
        return {
          success: false,
          message: (error as Error).message,
        };
      }
    },
    {
      body: t.Object({
        workspaceId: t.String({
          description: "Workspace ID",
          error: "Workspace ID is required",
        }),
        accessToken: t.Optional(
          t.String({
            description: "Access Token",
          }),
        ),
      }),
    },
  );
};
