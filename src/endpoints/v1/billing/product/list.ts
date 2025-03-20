import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1PostBillingProductList = async (
  app: Elysia<"/v1/billing/product">,
) => {
  return app.post(
    "/list",
    async ({ cookie, body }) => {
      try {
        const user = await getUser({ cookie, body });

        if (!user) {
          throw new Error("로그인 한 이용자만 사용가능합니다.");
        }

        // 1. 워크스페이스 확인 및 권한 체크
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

        // 2. 상품 목록 조회
        const { data: products, error: productsError } = await supabaseClient
          .from("llami_product")
          .select("*")
          .eq("is_deleted", false)
          .order("amount", { ascending: true });

        if (productsError) {
          console.error("상품 목록 조회 실패", productsError);
          throw new Error("상품 목록 조회에 실패했습니다");
        }

        // 3. 현재 워크스페이스의 구독 정보 조회
        const { data: subscription, error: subscriptionError } =
          await supabaseClient
            .from("llami_subscription")
            .select("product_id")
            .eq("workspace_id", body.workspaceId)
            .eq("is_deleted", false)
            .limit(1)
            .maybeSingle();

        return {
          success: true,
          data: products.map((product) => ({
            id: product.id,
            name: product.name,
            display_name: product.display_name,
            usage_limit: product.usage_limit,
            amount: product.amount,
            currency: product.currency,
            is_subscribed: subscription?.product_id === product.id,
          })),
          message: "상품 목록을 조회했습니다",
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
