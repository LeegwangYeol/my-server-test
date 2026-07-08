import { t } from "elysia";
import { isSmsConfigured, sendSms, activeProvider } from "../../../lib/sms";

/**
 * v2 SMS endpoints — server-side text messaging.
 *
 *   POST /v2/admin/sms/send  → send one SMS
 *
 * The backend is chosen by the SMS_PROVIDER env var (see lib/sms):
 *   phone  → 안드로이드 폰 게이트웨이 (진짜 0원, 기본값)
 *   solapi → SOLAPI(구 CoolSMS), 건당 과금
 *
 * Auth: shared secret in the `X-Admin-Token` header matching the ADMIN_TOKEN
 * env var, the same scheme as /v2/admin/mail/send. Sending SMS is abusable
 * (spam / cost / personal number), so the endpoint is fail-closed: when
 * ADMIN_TOKEN is unset it refuses to run.
 *
 * For bulk 명절 인사 to a contact list, use scripts/send-greetings.ts instead —
 * it adds personalization + throttling + a dry-run preview.
 */
export const v2SmsEndpoints = async (app: any) => {
  app.group("/v2", (app: any) => {
    app.post(
      "/admin/sms/send",
      async ({
        headers,
        body,
      }: {
        headers: Record<string, string | undefined>;
        body: {
          to: string;
          text: string;
        };
      }) => {
        const expected = process.env.ADMIN_TOKEN?.trim();
        if (!expected) {
          return {
            success: false,
            error: "ADMIN_TOKEN env var not set on server",
          };
        }
        const token = (headers["x-admin-token"] || "").trim();
        if (token !== expected) {
          return { success: false, error: "unauthorized" };
        }

        if (!isSmsConfigured()) {
          return {
            success: false,
            error: `SMS provider(${activeProvider()}) 환경변수 미설정 — phone: SMS_GATEWAY_* / solapi: SOLAPI_* 를 확인하세요.`,
          };
        }

        // 전화번호는 공백/하이픈을 제거해 전달 (예: "010-1234-5678" → "01012345678").
        const to = (body?.to ?? "").replace(/[\s-]/g, "").trim();
        const text = (body?.text ?? "").trim();
        if (!to) return { success: false, error: "to required" };
        if (!text) return { success: false, error: "text required" };

        try {
          const result = await sendSms({ phoneNumber: to, text });
          return { success: result.ok, ...result };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[v2/admin/sms/send] failed:", message);
          return { success: false, error: message };
        }
      },
      {
        body: t.Object({
          to: t.String(),
          text: t.String(),
        }),
        detail: {
          tags: ["API"],
          description: "Send SMS (provider set by SMS_PROVIDER)",
        },
      },
    );

    return app;
  });
};
