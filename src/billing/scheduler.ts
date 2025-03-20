import { SubscriptionInfo } from "@/types/billing";
import { sendPrimaryDiscordWebhook } from "@/src/utils/log/discord-logger";
import { BillingProcessor } from "./processor";
import { CronConfig } from "@elysiajs/cron";
import { supabaseClient } from "@/lib/supabase/client";
import { SupabaseClient } from "@supabase/supabase-js";
import { Database } from "@/lib/supabase/database.types";
import { TOSS_PAYMENTS_SECRET_KEY } from "@/lib/config";

export class BillingScheduler {
  private supabase;
  private request;
  private today;

  constructor(
    request?: Request,
    supabase?: SupabaseClient<Database>,
    today?: Date,
  ) {
    this.supabase = supabase || supabaseClient;
    this.request = request || new Request("https://llami.net");
    this.today = today || new Date();
  }

  async run() {
    try {
      // 1. 환경변수 검증
      if (!TOSS_PAYMENTS_SECRET_KEY) {
        throw new Error("TOSS_PAYMENTS_SECRET_KEY is not defined");
      }

      // 2. 날짜 처리 및 구독 조회
      const subscriptionDate = this.getSubscriptionDate(this.today);
      const subscriptions =
        await this.findSubscriptionsToProcess(subscriptionDate);

      if (subscriptions.length === 0) return;

      // 3. 구독별 처리 실행
      const processor = new BillingProcessor(this.supabase, this.request);
      for (const subscription of subscriptions) {
        try {
          await processor.process(subscription);
        } catch (error: any) {
          console.error(
            `Failed to process subscription ${subscription.id}:`,
            error,
          );
          await sendPrimaryDiscordWebhook(
            `[위험도: 중요] 구독 처리 실패\n구독 ID: ${subscription.id}\n에러: ${error.message}`,
            this.request,
          );
        }
      }
    } catch (error: any) {
      let message = `[스케줄러 실행 실패]\n${error.message}`;

      // * "upstream connect error or disconnect/reset before headers." 이면 해제
      if (
        typeof error.message === "string" &&
        error.message.includes(
          "upstream connect error or disconnect/reset before headers.",
        )
      )
        return;

      // * "구독 정보 조회 실패" 이면 해제
      if (error.message === "구독 정보 조회 실패")
        message = `[위험도: 심각] 구독 정보 조회 실패\n에러: ${error.message}`;
      await sendPrimaryDiscordWebhook(message, this.request);
      console.error("Scheduler execution failed:", error);

      throw error;
    }
  }

  // 날짜 처리 함수 ( 31일 같은 특수 경우를 위해서 )
  private getSubscriptionDate(date: Date): number {
    const lastDayOfMonth = new Date(
      date.getFullYear(),
      date.getMonth() + 1,
      0,
    ).getDate();
    const currentDay = date.getDate();

    return currentDay === lastDayOfMonth ? currentDay : date.getDate();
  }

  /**
   * 구독 조회 함수
   * 1. 연결된 카드가 동작하는 구독만 조회
   * 2. 삭제되지 않은 구독만 조회
   * 3. 오늘 결제일인 구독만 조회
   */

  private async findSubscriptionsToProcess(
    subscriptionDate: number,
  ): Promise<SubscriptionInfo[]> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(23, 59, 59, 999);

    // 1. 오늘 결제된 workspace_id 목록 조회
    const { data: todayPayments } = await this.supabase
      .from("llami_widget_payment_log")
      .select("workspace_id")
      .gte("payment_at", yesterday.toISOString())
      .eq("payment_type", "Subscription");

    const paidWorkspaceIds = todayPayments?.map((p) => p.workspace_id) || [];

    // 2. 결제가 필요한 구독 조회
    const { data: subscriptions, error } = await this.supabase
      .from("llami_subscription")
      .select(
        `*,
        card:llami_billing_card!inner (*),
        product:llami_product!inner (*),
        workspace:llami_workspace!inner (
          *,
          user!inner (*)
        )
        `,
      )
      .eq("is_deleted", false)
      .eq("subscription_date", subscriptionDate)
      .eq("card.is_working", true)
      .not("workspace_id", "in", `(${paidWorkspaceIds.join(",")})`)
      .order("updated_at", { ascending: true })
      .limit(10);

    if (error) {
      console.error("구독 정보 조회 실패:", error);
      throw error;
    }

    return subscriptions;
  }
}

export const processBillingSchedule: CronConfig = {
  name: "scheduleBilling",
  pattern: "*/10 * * * * *",
  run: () => new BillingScheduler().run(),
};
