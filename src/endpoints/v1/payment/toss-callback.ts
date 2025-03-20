import { supabaseClient } from "@/lib/supabase/client";
import {
  sendPrimaryDiscordWebhook,
  writeWorkspaceLog,
} from "@/src/utils/log/discord-logger";
import { normalizePhoneNumber } from "@/src/utils/normalize-phone-number";
import { parsePhoneNumber } from "@/src/utils/parse-phone-number";
import { validatePhoneNumber } from "@/src/utils/validate-phone-number";
import { Elysia, t } from "elysia";

type TossCallback =
  | {
      mid: string;
      status: "APPROVAL";
      /**
       * (중요정보) 결제금액
       */
      amount: number;
      orderId: string;
      paymentKey: string;
      paymentMethod: string;
      /**
       * (중요정보) 고객 전화번호
       */
      customerPhoneNumber: string;
      shipping: {
        fullAddress: string;
        /**
         * (중요정보) 주문자
         */
        receiver: string;
        postalCode: string;
        address: string;
        detailAddress: string;
      };
    }
  | {
      status: "DONE";
      /**
       * (중요정보) 주문명
       */
      orderName: string;
      orderId: string;
      mId: string;
      lastTransactionKey: string;
      paymentKey: string;
      taxExemptionAmount: number;
      requestedAt: Date;
      approvedAt: Date;
      useEscrow: boolean;
      cultureExpense: boolean;
      card: null;
      virtualAccount: null;
      transfer: null;
      mobilePhone: null;
      giftCertificate: null;
      cashReceipt: null;
      cashReceipts: null;
      discount: null;
      cancels: null;
      secret: string;
      type: string;
      easyPay: {
        provider: string;
        amount: number;
        discountAmount: number;
      };
      country: string;
      failure: null;
      isPartialCancelable: boolean;
      receipt: {
        url: string;
      };
      checkout: {
        url: string;
      };
      transactionKey: string;
      currency: string;
      totalAmount: number;
      balanceAmount: number;
      suppliedAmount: number;
      vat: number;
      taxFreeAmount: number;
      method: string;
      version: Date;
    };

export const v1PaymentTossCallback = async (app: Elysia<"/v1/payment">) => {
  app.post(
    "/toss/callback",
    async ({ body: _body, request }) => {
      const body = _body as TossCallback;
      const ip = request.headers.get("cf-connecting-ip");

      // * 해당 요청이 들어와도 발송지가 토스페이먼츠의 IP 주소여야만 허용합니다.
      // * @see https://docs.tosspayments.com/guides/environment#%EB%B0%A9%ED%99%94%EB%B2%BD-%EC%84%A4%EC%A0%95%ED%95%98%EA%B8%B0
      const allowedIps = [
        "13.124.18.147",
        "13.124.108.35",
        "3.36.173.151",
        "3.38.81.32",
      ];

      if (ip) {
        if (!allowedIps.includes(ip)) {
          console.error("잘못된 IP가 접근하였습니다.");
          return new Response("허용되지 않은 IP에서의 요청입니다.", {
            status: 403,
          });
        }
      }

      // TODO 추후에 DONE 에서 orderName 으로 어느 서비스에 결제가 발생한건지 체크해서 분기처리해야 합니다.
      // TODO 현재 아래는 전부 LLAMI CHAT (WIDGET) 결제에 대한 로직입니다.

      // * DONE(결제완료)가 발생하고 나서 APPROVAL(결제승인)이 발생합니다.
      if (body.status === "APPROVAL") {
        if (!validatePhoneNumber(body.customerPhoneNumber))
          throw new Error("전화번호 형식이 잘못되었습니다.");

        const phoneNumber = normalizePhoneNumber(
          parsePhoneNumber(body.customerPhoneNumber),
        );

        // * 유저 정보 확인
        let { data: user } = await supabaseClient
          .from("user")
          .select("*")
          .eq("phone_number", phoneNumber)
          .limit(1)
          .maybeSingle();

        // * 유저 정보가 없을 경우 생성
        if (!user) {
          const { data: newUser } = await supabaseClient
            .from("user")
            .insert({ phone_number: phoneNumber })
            .select("*")
            .limit(1)
            .maybeSingle();

          if (newUser) {
            user = newUser;
          }

          // * 유저 정보가 없을 경우 에러
          if (!user) {
            console.error("유저 정보가 없습니다.");
            sendPrimaryDiscordWebhook(
              `🚨 [위험도: 매우심각] [즉각 개발자에게 알려주세요!] 결제 정보를 연결할 수 없는 결제 건 발생됨! (해당 전화번호 ${body.customerPhoneNumber})`,
              request,
            );
            return new Response("유저 정보가 없습니다.", {
              status: 404,
            });
          }

          // * 유저 워크스페이스 및 리미트 테이블 생성
          const { data: workspace } = await supabaseClient
            .from("llami_workspace")
            .insert({
              owner: user.id,
            })
            .select("*")
            .limit(1)
            .maybeSingle();

          if (!workspace) {
            console.error("워크스페이스 생성 실패");
            sendPrimaryDiscordWebhook(
              `🚨 [위험도: 매우심각] [즉각 개발자에게 알려주세요!] 워크스페이스 정보를 연결할 수 없는 결제 건 발생됨! (해당 전화번호 ${body.customerPhoneNumber})`,
              request,
            );
            return new Response("워크스페이스 생성 실패", {
              status: 500,
            });
          }

          // * 유저 워크스페이스 리미트 테이블 생성
          await supabaseClient.from("llami_workspace_usage_limit").insert({
            workspace_id: workspace.id,
            refresh_usage_count: 20,
            special_usage_count: 0,
            usage_alert_count: 4,
          });
        }

        // * 결재내역 페이먼트 로그 추가
        const response = await supabaseClient
          .from("llami_widget_payment_log")
          .insert({
            price: body.amount,
            service_name: "LLAMI CHAT",
            payer_phone_number: phoneNumber,
            payer_id: user.id,
            payment_metohd: body.paymentMethod,
            payment_type: "Toss Payment (Linkpay)",
            status: "결제승인",
          });

        if (response.error) {
          console.error("결제 로그 추가 실패", response.error);
          return new Response("결제 로그 추가 실패", {
            status: 500,
          });
        }

        // * 유저가 소속된 모든 워크스페이스 정보 가져오기
        const { data: workspaces } = await supabaseClient
          .from("llami_workspace")
          .select("*")
          .eq("owner", user.id);

        // * 해당 유저가 소속된 워크스페이스가 1개일 경우 해당 워크스페이스 리미트를 확인하고 추가하고, 1개 이상일 경우 이용자 예치금으로 추가
        if (workspaces?.length === 1) {
          // * 해당 워크스페이스 현재 리미트 확인
          const workspace = workspaces[0];
          const { data: workspaceLimit } = await supabaseClient
            .from("llami_workspace_usage_limit")
            .select("*")
            .eq("workspace_id", workspace.id)
            .limit(1)
            .maybeSingle();

          // * 해당 워크스페이스에 리미트 추가
          await supabaseClient
            .from("llami_workspace_usage_limit")
            .upsert({
              workspace_id: workspace.id,
              special_usage_count:
                (workspaceLimit?.special_usage_count ?? 0) + 10000,
            })
            .eq("workspace_id", workspace.id);

          // * 결제 완료 로그 추가
          writeWorkspaceLog(
            {
              code: "PAYMENT_APPROVAL",
              issued_user_id: user.id,
              workspace_id: workspace.id,
              message: `💳 라미챗에 ${body.amount}원 결제가 승인되었습니다.\n> **${phoneNumber}**님이 **${
                workspace.name ?? "개인계정"
              }** 그룹에 라미챗 결제를 진행하였습니다.`,
            },
            request,
          );
        } else {
          // * 유저 예치금 조회
          const { data: deposit } = await supabaseClient
            .from("llami_deposit")
            .select("*")
            .eq("user", user.id)
            .limit(1)
            .maybeSingle();

          // * 유저 예치금 추가
          await supabaseClient.from("llami_deposit").upsert({
            user: user.id,
            workspace_month_pay: (deposit?.workspace_month_pay ?? 0) + 1,
          });

          // * 결제 완료 로그 추가
          sendPrimaryDiscordWebhook(
            `💳 라미챗에 **${body.amount}**원 결제가 승인되었습니다.\n> **${body.customerPhoneNumber}**님의 참여된 그룹이 여러개여서 예치금 형태로 충전되었습니다.`,
            request,
          );
        }
      }
    },
    {
      detail: {
        tags: ["Payment"],
        description: "Toss payment callback (Only can access from Toss IP)",
      },
    },
  );
};
