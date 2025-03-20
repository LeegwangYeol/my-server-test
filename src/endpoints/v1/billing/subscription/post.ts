import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { sendPrimaryDiscordWebhook } from "@/src/utils/log/discord-logger";
import { Elysia, t } from "elysia";

export const v1PostBillingSubscription = async (
  app: Elysia<"/v1/billing/subscription">,
) => {
  return app.post(
    "/",
    async ({ cookie, body, request }) => {
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

        // 2. 카드가 워크스페이스의 소유인지 확인
        const { data: card, error: cardError } = await supabaseClient
          .from("llami_billing_card")
          .select("*")
          .eq("id", body.cardId)
          .eq("user_id", user.id)
          .eq("is_deleted", false)
          .limit(1)
          .maybeSingle();

        if (cardError || !card) {
          throw new Error("유효하지 않은 카드입니다.");
        }

        // 3. 상품 정보 조회 및 유효성 검증
        const { data: product, error: productError } = await supabaseClient
          .from("llami_product")
          .select("*")
          .eq("id", body.productId)
          .eq("is_deleted", false)
          .limit(1)
          .maybeSingle();

        if (productError || !product) {
          throw new Error("상품을 찾을 수 없습니다.");
        }

        // 4. 이미 해당 상품을 구독 중인지 확인
        const { data: existingSubscription, error: existingError } =
          await supabaseClient
            .from("llami_subscription")
            .select("*")
            .eq("workspace_id", body.workspaceId)
            .eq("product_id", body.productId)
            .eq("is_deleted", false)
            .limit(1)
            .maybeSingle();

        if (existingSubscription) {
          throw new Error("이미 구독 중인 상품입니다.");
        }

        // 4. 구독 정보 저장
        const { error: subscriptionError } = await supabaseClient
          .from("llami_subscription")
          .insert({
            workspace_id: body.workspaceId,
            billing_card_id: card.id,
            product_id: product.id,
            subscription_date: new Date().getDate(),
            is_deleted: false,
          });

        {
          if (subscriptionError) {
            console.error("구독 정보 저장 실패", subscriptionError);
            await sendPrimaryDiscordWebhook(
              `❌ 구독 신청 실패!\n` +
                `상품: ${product.display_name}\n` +
                `워크스페이스: ${workspace.name} (${body.workspaceId})\n` +
                `구독자: ${user.phone_number}\n` +
                `에러: 구독 정보 저장 실패`,
              request,
            );
            return {
              success: false,
              message: "구독 정보 저장 실패",
            };
          }

          // 구독 성공 알림
          await sendPrimaryDiscordWebhook(
            `✨ 새로운 구독 신청 성공!\n` +
              `상품: ${product.display_name}\n` +
              `가격: ${product.amount.toLocaleString()}원/월\n` +
              `워크스페이스: ${workspace.name} (${body.workspaceId})\n` +
              `구독자: ${user.phone_number}\n` +
              `구독 시작일: ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
            request,
          );

          return {
            success: true,
            message: "구독이 시작되었습니다",
          };
        }
      } catch (error) {
        // 기타 에러 발생 시 알림
        await sendPrimaryDiscordWebhook(
          `❌ 구독 신청 실패!\n` +
            `워크스페이스: ${body.workspaceId}\n` +
            `에러: ${(error as Error).message}`,
          request,
        );

        return {
          success: false,
          message: (error as Error).message,
        };
      }
    },
    {
      detail: {
        tags: ["Billing"],
        description: "Post subscription information",
      },
      body: t.Object({
        productId: t.String({
          description: "Product ID",
          error: "Product ID is required",
        }),
        workspaceId: t.String({
          description: "Workspace ID",
          error: "Workspace ID is required",
        }),
        cardId: t.String({
          description: "Card ID to use for subscription",
          error: "Card ID is required",
        }),
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
