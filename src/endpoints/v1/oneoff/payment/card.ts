import { t } from "elysia";
import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { sendPrimaryDiscordWebhook } from "@/src/utils/log/discord-logger";
import Elysia from "elysia";
import axios from "axios";

const getUserFriendlyErrorMessage = (errorCode: string): string => {
  switch (errorCode) {
    case "INVALID_CARD_NUMBER":
      return "카드번호가 올바르지 않습니다. 다시 확인해주세요.";
    case "INVALID_CARD_EXPIRATION":
      return "카드 유효기간이 만료되었습니다. 다른 카드로 결제해주세요.";
    case "INVALID_STOPPED_CARD":
      return "정지된 카드입니다. 다른 카드로 결제해주세요.";
    case "EXCEED_MAX_DAILY_PAYMENT_COUNT":
      return "하루 결제 가능 횟수를 초과했습니다. 내일 다시 시도해주세요.";
    case "EXCEED_MAX_PAYMENT_AMOUNT":
      return "하루 결제 가능 금액을 초과했습니다. 내일 다시 시도해주세요.";
    case "REJECT_ACCOUNT_PAYMENT":
      return "잔액부족으로 결제에 실패했습니다. 다른 카드로 결제해주세요.";
    default:
      return "결제 처리 중 오류가 발생했습니다. 다시 시도해주세요.";
  }
};

export const v1OneoffCard = async (app: Elysia<"/v1/oneoff/payment">) => {
  return app.post(
    "/card",
    async ({ cookie, body, request }) => {
      let user;
      let product;

      try {
        // 1. 사용자 정보 조회
        user = await getUser({ cookie, body });
        if (!user) {
          throw new Error("로그인 한 이용자만 사용가능합니다.");
        }

        // 2. 제품 정보 조회
        const { data: productData, error: productError } = await supabaseClient
          .from("llami_product")
          .select("*")
          .eq("id", body.productId)
          .single();

        if (productError || !productData) {
          throw new Error("상품 정보를 찾을 수 없습니다.");
        }
        product = productData;

        // 3. 현재 워크스페이스 정보 조회
        const { data: workspace_limit, error: workspaceError } =
          await supabaseClient
            .from("llami_workspace_usage_limit")
            .select("*")
            .eq("workspace_id", body.workspaceId)
            .single();

        if (workspaceError || !workspace_limit) {
          throw new Error("워크스페이스 정보를 찾을 수 없습니다.");
        }

        // 4. 결제 금액 검증
        if (product.amount !== body.amount) {
          throw new Error("결제 금액이 일치하지 않습니다.");
        }

        // 5. 결제 승인 요청
        const response = await axios.post(
          "https://api.tosspayments.com/v1/payments/confirm",
          {
            paymentKey: body.paymentKey,
            orderId: body.orderId,
            amount: body.amount,
          },
          {
            headers: {
              Authorization: `Basic ${Buffer.from(
                process.env.TOSS_PAYMENTS_SECRET_KEY + ":",
              ).toString("base64")}`,
            },
          },
        );

        // 6. 워크스페이스 사용량 제한 업데이트 (누적)
        const newUsageLimit =
          (workspace_limit.special_usage_count || 0) + product.usage_limit;
        const { error: updateError } = await supabaseClient
          .from("llami_workspace_usage_limit")
          .update({
            special_usage_count: newUsageLimit,
            updated_at: new Date().toISOString(),
          })
          .eq("workspace_id", body.workspaceId);

        if (updateError) {
          throw new Error("워크스페이스 사용량 제한 업데이트 실패");
        }

        // 7. 결제 로그 기록
        const { error: logError } = await supabaseClient
          .from("llami_widget_payment_log")
          .insert({
            workspace_id: body.workspaceId,
            status: "SUCCESS",
            payment_at: new Date().toISOString(),
            price: body.amount,
            service_name: product.display_name,
            payer_phone_number: user.phone_number,
            payer_id: user.id,
            payment_metohd: "Toss Payments",
            payment_type: "card",
          });

        if (logError) {
          await sendPrimaryDiscordWebhook(
            `[위험도: 중요] 결제 로그 기록 실패\n워크스페이스: ${body.workspaceId}`,
            request,
          );
          throw new Error("결제 로그 기록에 실패했습니다.");
        } else {
          // 결제 성공 알림
          await sendPrimaryDiscordWebhook(
            `💰 결제 성공!\n` +
              `상품: ${product.display_name}\n` +
              `금액: ${body.amount.toLocaleString()}원\n` +
              `결제자: ${user.phone_number}\n` +
              `워크스페이스: ${body.workspaceId}\n` +
              `결제 시간: ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
            request,
          );
        }

        return {
          success: true,
          message: "카드 일회성 결제 성공",
        };
      } catch (error: any) {
        const errorCode = error.response?.data?.code || "UNKNOWN_ERROR";
        const errorMessage = error.response?.data?.message || error.message;

        // 실패 로그 기록 - 이제 user와 product를 안전하게 사용 가능
        const { error: logError } = await supabaseClient
          .from("llami_widget_payment_log")
          .insert({
            workspace_id: body.workspaceId,
            status: "FAILED",
            payment_at: new Date().toISOString(),
            price: body.amount,
            service_name: product?.display_name || "Unknown Product",
            payer_phone_number: user?.phone_number || "",
            payer_id: user?.id || "",
            payment_metohd: "Toss Payments",
            payment_type: "card",
          });

        if (logError) {
          await sendPrimaryDiscordWebhook(
            `[위험도: 심각] 결제 실패 로그 기록 실패\n워크스페이스: ${body.workspaceId}`,
            request,
          );
          console.error(logError);
        }

        await sendPrimaryDiscordWebhook(
          `[위험도: 중요] 카드 결제 실패\n워크스페이스: ${body.workspaceId}\n결제 금액: ${body.amount}원\n에러 코드: ${errorCode}\n에러 메시지: ${errorMessage}`,
          request,
        );

        return {
          success: false,
          message: getUserFriendlyErrorMessage(errorCode),
        };
      }
    },
    {
      detail: {
        tags: ["Billing"],
        description: "Process one-time card payment",
      },
      body: t.Object({
        accessToken: t.Optional(t.String()),
        paymentKey: t.String(),
        orderId: t.String(),
        amount: t.Number(),
        productId: t.String(),
        workspaceId: t.String(),
      }),
      response: t.Object({
        success: t.Boolean(),
        message: t.String(),
      }),
    },
  );
};
