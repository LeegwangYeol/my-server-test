import axios from "axios";
import { v4 as uuid } from "uuid";
import { supabaseClient } from "@/lib/supabase/client";
import type { CronConfig } from "@elysiajs/cron";
import { sendPrimaryDiscordWebhook } from "@/src/utils/log/discord-logger";
import { sendSms } from "@/lib/sms/solapi";

export const processBillingSchedule: CronConfig = {
  name: "scheduleBilling",
  pattern: "0 * * * * *",
  run: scheduleBilling,
};

export async function scheduleBilling() {
  console.log("정기 결제 스케줄러 실행:", new Date().toISOString());

  try {
    // 1. 오늘 결제할 구독 조회
    const { data: subscriptions, error: subscriptionError } =
      await supabaseClient
        .from("llami_subscription")
        .select(
          `
            *,
            llami_billing_card (*),
            llami_product (*),
            llami_workspace!inner (
              id,
              name,
              owner
            )
            `,
        )
        .eq("is_deleted", false)
        .eq("subscription_date", new Date().getDate())
        .order("updated_at", { ascending: false })
        .limit(10);

    if (subscriptionError) {
      console.error("구독 정보 조회 실패:", subscriptionError);
      return;
    }

    console.log(`처리할 구독 건수: ${subscriptions?.length || 0}`);

    // 2. 각 구독별 결제 처리
    for (const subscription of subscriptions || []) {
      try {
        // 2-1. 오늘 이미 결제된 건인지 확인
        const today = new Date();
        const startOfDay = new Date(
          today.getFullYear(),
          today.getMonth(),
          today.getDate(),
        ).toISOString();
        const endOfDay = new Date(
          today.getFullYear(),
          today.getMonth(),
          today.getDate(),
          23,
          59,
          59,
          999,
        ).toISOString();

        const { count } = await supabaseClient
          .from("llami_widget_payment_log")
          .select("*", { count: "exact" })
          .eq("workspace_id", subscription.workspace_id)
          .eq("status", "결제승인")
          .gte("payment_at", startOfDay)
          .lte("payment_at", endOfDay);

        if (count && count > 0) {
          console.log(`구독 ${subscription.id}: 이미 오늘 결제가 완료된 건`);
          return;
        }

        if (
          !subscription.llami_billing_card ||
          !subscription.llami_product ||
          !subscription.llami_workspace
        ) {
          console.error(
            `구독 ${subscription.id}: 카드/상품/워크스페이스 정보 누락`,
          );
          return;
        }

        // 2-2. 결제 실행
        const secretKey = process.env.TOSS_PAYMENTS_SECRET_KEY;
        if (!secretKey)
          throw new Error("토스페이먼츠 시크릿 키가 설정되지 않았습니다.");

        const response = await axios.post(
          `https://api.tosspayments.com/v1/billing/${subscription.llami_billing_card.billing_key}`,
          {
            customerKey: subscription.llami_workspace.owner,
            amount: subscription.llami_product.amount,
            orderId: uuid(),
            orderName: `${subscription.llami_workspace.name ?? "개인계정"} - ${subscription.llami_product.name}`,
          },
          {
            headers: {
              Authorization: `Basic ${Buffer.from(secretKey + ":").toString("base64")}`,
              "Content-Type": "application/json",
            },
          },
        );

        console.log(`구독 ${subscription.id}: 토스페이먼츠 응답`, {
          paymentKey: response.data.paymentKey,
          orderId: response.data.orderId,
          status: response.data.status,
        });

        // 2-3. 결제 이력 기록
        await supabaseClient.from("llami_widget_payment_log").insert({
          price: subscription.llami_product.amount,
          service_name: "LLAMI CHAT",
          payer_id: subscription.llami_workspace.owner,
          workspace_id: subscription.llami_workspace.id,
          payment_metohd: "Toss Billing",
          payment_type: "Subscription",
          status: "결제승인",
        });

        console.log(`구독 ${subscription.id}: 결제 성공`);
      } catch (error: any) {
        console.error(`구독 ${subscription.id}: 결제 실패`, error);

        // 카드 정보 마스킹 처리
        const maskedCardNumber = subscription.llami_billing_card.card_number;
        const cardCompany = subscription.llami_billing_card.card_company;
        const productName = subscription.llami_product.name;
        const amount = subscription.llami_product.amount.toLocaleString();
        const workspaceName = subscription.llami_workspace.name ?? "개인계정";

        if (axios.isAxiosError(error)) {
          const errorCode = error.response?.data?.code;
          const errorMessage = error.response?.data?.message;
          const failureTime = new Date().toLocaleString("ko-KR", {
            timeZone: "Asia/Seoul",
          });

          // 결제 거절/한도 관련 에러
          switch (error.response?.data?.code) {
            case "REJECT_CARD_COMPANY": // 결제 승인 거절
            case "REJECT_CARD_PAYMENT": // 한도초과/잔액부족
            case "INVALID_REJECT_CARD": // 카드사에서 거절
            case "EXCEED_MAX_PAYMENT_AMOUNT": // 하루 결제한도 초과
            case "EXCEED_MAX_DAILY_PAYMENT_COUNT": // 하루 결제횟수 초과
              try {
                const { error: card_update_error } = await supabaseClient
                  .from("llami_billing_card")
                  .update({ is_working: false })
                  .eq("id", subscription.llami_billing_card.id);

                if (card_update_error) throw new Error("카드 업데이트 실패");

                const { data: owner, error: owner_error } = await supabaseClient
                  .from("user")
                  .select("phone_number")
                  .eq("id", subscription.llami_workspace.owner)
                  .limit(1)
                  .maybeSingle();

                if (owner_error) throw new Error("카드 업데이트 실패");

                if (owner?.phone_number) {
                  await sendSms({
                    phoneNumber: owner.phone_number,
                    text:
                      `(LLAMI) 정기 결제 실패 안내\n` +
                      `${workspaceName}의 ${productName} 정기 결제(${amount}원)가 실패했습니다.\n` +
                      `카드: ${cardCompany} ${maskedCardNumber}\n` +
                      `실패 시각: ${failureTime}\n` +
                      `결제 수정: https://llami.net/widget/payment`,
                  });
                }
              } catch (smsError: any) {
                throw new Error(`SMS 발송 실패: ${smsError}`);
              }
          }

          // 1. 유저에게 SMS 발송

          // Discord로 결제 실패 메시지 전송
          await sendPrimaryDiscordWebhook(
            `💳 [위험도: 중요] 정기 결제 실패 알림\n` +
              `> **워크스페이스 정보**\n` +
              `> - 이름: ${workspaceName}\n` +
              `> - ID: ${subscription.workspace_id}\n\n` +
              `> **결제 정보**\n` +
              `> - 상품: ${productName}\n` +
              `> - 금액: ${amount}원\n` +
              `> - 카드: ${cardCompany} ${maskedCardNumber}\n\n` +
              `> **오류 정보**\n` +
              `> - 시각: ${failureTime}\n` +
              `> - 코드: ${errorCode}\n` +
              `> - 메시지: ${errorMessage}\n\n` +
              `> **구독 정보**\n` +
              `> - 구독 ID: ${subscription.id}\n` +
              `> - 결제일: ${subscription.subscription_date}일`,
            new Request("https://llami.net"),
          );
        }

        // 3. 결제 실패 로그 기록
        await supabaseClient.from("llami_widget_payment_log").insert({
          price: subscription.llami_product.amount,
          service_name: "LLAMI CHAT",
          payer_id: subscription.llami_workspace.owner,
          workspace_id: subscription.llami_workspace.id,
          payment_metohd: "Toss Billing",
          payment_type: "Subscription",
          status: "결제실패",
          subscription_id: subscription.id,
          error_code: error.response?.data?.code,
          error_message: (error as Error).message,
          card_info: `${cardCompany} ${maskedCardNumber}`,
          failed_at: new Date().toISOString(),
        });
      }
    }

    console.log("정기 결제 스케줄러 완료");
  } catch (error) {
    console.error("정기 결제 스케줄러 오류:", error);

    // Discord로 에러 메시지 전송
    await sendPrimaryDiscordWebhook(
      `🚨 [위험도: 심각] 정기 결제 스케줄러에서 오류가 발생했습니다.\n> 에러 메시지: ${(error as Error).message}`,
      new Request("https://llami.net"), // Request 객체 필요
    );
  }
}
