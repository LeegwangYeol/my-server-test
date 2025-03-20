import { SupabaseClient } from "@supabase/supabase-js";
import { Database } from "@/lib/supabase/database.types";
import {
  SubscriptionInfo,
  BillingStatus,
  PaymentResult,
} from "@/types/billing";
import { sendPrimaryDiscordWebhook } from "@/src/utils/log/discord-logger";
import { v4 as uuid } from "uuid";
import { sendSms } from "@/lib/sms/solapi";
import axios from "axios";

export class BillingProcessor {
  constructor(
    private supabase: SupabaseClient<Database>,
    private request: Request,
  ) {}

  async process(subscription: SubscriptionInfo): Promise<void> {
    try {
      // 1. 구독 정보 업데이트
      await this.updateSubscriptionDate(subscription.id);

      // 2. 정보 유효성 검증
      this.validateSubscriptionInfo(subscription);

      // 3. 결제 처리
      const paymentResult = await this.processPayment(subscription);

      // 4. 결제 로그 기록
      await this.recordPaymentLog(paymentResult);

      // 5. 워크스페이스 사용량 제한 업데이트
      await this.updateWorkspaceUsageLimit(subscription);

      // 6. 결제 실패시 추가 처리
      if (paymentResult.status === BillingStatus.CARD_PAYMENT_FAILED) {
        throw new Error("카드 결제 실패");
      }
    } catch (error: any) {
      const status = error.status || BillingStatus.NETWORK_ERROR;

      // 에러 로그 기록
      await this.recordPaymentLog({
        subscription_id: subscription.id,
        workspace_id: subscription.workspace?.id || "",
        status,
        amount: subscription.product?.amount,
        payment_at: new Date().toISOString(),
        service_name: subscription.product?.display_name || "",
        payer_phone_number: subscription.workspace?.user?.phone_number || "",
        payer_id: subscription.workspace?.user?.id || "",
        payment_method: "Toss Billing",
        payment_type: "Subscription",
      });

      // Discord 알림 발송
      const errorMessage = this.getErrorMessage(status, subscription);

      if (
        error.message === "카드 결제 실패" ||
        error.status === BillingStatus.CARD_PAYMENT_FAILED
      )
        await this.handlePaymentFailure(subscription);

      await sendPrimaryDiscordWebhook(errorMessage, this.request);
      if (error.message === "결제 로그 기록 실패")
        sendPrimaryDiscordWebhook(
          `[위험도: 중요] 결제 로그 기록 실패\n구독 ID: ${subscription.id}`,
          this.request,
        );

      throw error;
    }
  }

  private validateSubscriptionInfo(subscription: SubscriptionInfo): void {
    if (!subscription.card?.billing_key) {
      throw {
        status: BillingStatus.MISSING_CARD,
        message: "카드 정보가 없습니다.",
      };
    }
    if (!subscription.product) {
      throw {
        status: BillingStatus.MISSING_PRODUCT,
        message: "상품 정보가 없습니다.",
      };
    }
    if (!subscription.workspace) {
      throw {
        status: BillingStatus.MISSING_WORKSPACE,
        message: "워크스페이스 정보가 없습니다.",
      };
    }
  }

  private async processPayment(
    subscription: SubscriptionInfo,
  ): Promise<PaymentResult> {
    try {
      const response = await axios.post(
        `https://api.tosspayments.com/v1/billing/${subscription.card?.billing_key}`,
        {
          orderId: uuid(),
          amount: subscription.product?.amount,
          customerKey: subscription.workspace?.owner,
          billingKey: subscription.card?.billing_key,
          orderName: `${subscription.workspace?.name} - ${subscription.product?.display_name}`,
        },
        {
          headers: {
            Authorization: `Basic ${Buffer.from(process.env.TOSS_PAYMENTS_SECRET_KEY + ":").toString("base64")}`,
          },
        },
      );

      return {
        subscription_id: subscription.id,
        workspace_id: subscription.workspace?.id || "",
        status: BillingStatus.SUCCESS,
        amount: subscription.product?.amount,
        payment_at: new Date().toISOString(),
        service_name: subscription.product?.display_name || "",
        payer_phone_number: subscription.workspace?.user?.phone_number || "",
        payer_id: subscription.workspace?.user?.id || "",
        payment_method: "Toss Billing",
        payment_type: "Subscription",
      };
    } catch (error: any) {
      throw {
        status: BillingStatus.CARD_PAYMENT_FAILED,
        message: error.response?.data?.message || "카드 결제 실패",
      };
    }
  }

  private async recordPaymentLog(result: PaymentResult): Promise<void> {
    const { error } = await this.supabase
      .from("llami_widget_payment_log")
      .insert({
        workspace_id: result.workspace_id,
        status: result.status,
        payment_at: result.payment_at,
        price: result.amount,
        service_name: result.service_name,
        payer_phone_number: result.payer_phone_number,
        payer_id: result.payer_id,
        payment_metohd: result.payment_method,
        payment_type: result.payment_type,
      });

    if (error) {
      console.error("결제 로그 기록 실패:", error);
      throw new Error("결제 로그 기록 실패");
    }
  }

  private async updateSubscriptionDate(subscriptionId: string): Promise<void> {
    const { error } = await this.supabase
      .from("llami_subscription")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", subscriptionId);

    if (error) throw error;
  }

  private async handlePaymentFailure(
    subscription: SubscriptionInfo,
  ): Promise<void> {
    try {
      // 1. 카드 상태 변경
      const { error: cardError } = await this.supabase
        .from("llami_billing_card")
        .update({ is_working: false })
        .eq("id", subscription.card?.id || "");

      if (cardError) throw cardError;

      // 3. SMS 발송
      const { data: owner, error: ownerError } = await this.supabase
        .from("user")
        .select("phone_number")
        .eq("id", subscription.workspace?.owner || "")
        .single();

      if (ownerError) throw ownerError;

      if (owner?.phone_number) {
        await sendSms({
          phoneNumber: owner.phone_number,
          text: `[LLAMI] 결제 실패 안내\n워크스페이스: ${subscription.workspace?.name}\n금액: ${subscription.product?.amount}원\n카드 정보를 확인해주세요.`,
        });
      }
    } catch (error: any) {
      console.error("결제 실패 처리 중 오류:", error);
      await sendPrimaryDiscordWebhook(
        `[위험도: 심각] 결제 실패 처리 오류\n워크스페이스: ${subscription.workspace?.name}\n구독 ID: ${subscription.id}\n에러: ${error.message}`,
        this.request,
      );
      throw error;
    }
  }

  private getErrorMessage(
    status: BillingStatus,
    subscription: SubscriptionInfo,
  ): string {
    const baseInfo = `워크스페이스: ${subscription.workspace?.name}\n구독 ID: ${subscription.id}`;

    switch (status) {
      case BillingStatus.MISSING_CARD:
        return `[위험도: 중요] 카드 정보 누락\n${baseInfo}`;
      case BillingStatus.MISSING_PRODUCT:
        return `[위험도: 중요] 상품 정보 누락\n${baseInfo}`;
      case BillingStatus.MISSING_WORKSPACE:
        return `[위험도: 중요] 워크스페이스 정보 누락\n${baseInfo}`;
      case BillingStatus.MISSING_USER:
        return `[위험도: 중요] 사용자 정보 누락\n${baseInfo}`;
      case BillingStatus.CARD_PAYMENT_FAILED:
        return `[위험도: 중요] 카드 결제 실패\n${baseInfo}\n금액: ${subscription.product?.amount}원`;
      case BillingStatus.NETWORK_ERROR:
        return `[위험도: 심각] 네트워크 오류\n${baseInfo}`;
      default:
        return `[위험도: 심각] 알 수 없는 오류\n${baseInfo}`;
    }
  }

  private async updateWorkspaceUsageLimit(
    subscription: SubscriptionInfo,
  ): Promise<void> {
    try {
      // 필수 값 검증
      if (!subscription.workspace?.id) {
        throw {
          status: BillingStatus.MISSING_WORKSPACE,
          message: "워크스페이스 ID가 없습니다.",
        };
      }

      if (!subscription.product?.usage_limit) {
        throw {
          status: BillingStatus.MISSING_PRODUCT,
          message: "상품의 사용량 제한 정보가 없습니다.",
        };
      }

      // 1. 현재 워크스페이스 usage limit 조회
      const { data: workspace_limit, error: limitError } = await this.supabase
        .from("llami_workspace_usage_limit")
        .select("*")
        .eq("workspace_id", subscription.workspace.id)
        .single();

      if (limitError) {
        throw new Error("워크스페이스 사용량 제한 조회 실패");
      }

      // 2. 새로운 usage limit 계산 (누적)
      const newUsageLimit =
        (workspace_limit.special_usage_count || 0) +
        subscription.product.usage_limit;

      // 3. usage limit 업데이트
      const { error: updateError } = await this.supabase
        .from("llami_workspace_usage_limit")
        .update({
          special_usage_count: newUsageLimit,
          updated_at: new Date().toISOString(),
        })
        .eq("workspace_id", subscription.workspace.id);

      if (updateError) {
        throw new Error("워크스페이스 사용량 제한 업데이트 실패");
      }
    } catch (error: any) {
      console.error("Usage limit 업데이트 실패:", error);
      await sendPrimaryDiscordWebhook(
        `[위험도: 중요] Usage limit 업데이트 실패\n워크스페이스: ${subscription.workspace?.name}\n구독 ID: ${subscription.id}\n에러: ${error.message}`,
        this.request,
      );
      throw error;
    }
  }
}
