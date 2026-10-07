import { t } from "elysia";
import { isSmsConfigured, sendSms, activeProvider } from "../../../lib/sms";

/**
 * v2 SMS endpoints — server-side text messaging.
 *
 *   POST /v2/admin/sms/send  → send one SMS
 *
 * 백엔드는 Pushbullet 하나다 (lib/sms) — 서버리스에서 실행 가능한 유일한 경로.
 * iMessage·SMS Gate 같은 맥 로컬 전용 경로는 서버에서 못 돌아가므로
 * test/sms-local/ 로 분리돼 있다. 여기로 끌어오지 말 것.
 *
 * Auth: shared secret in the `X-Admin-Token` header matching the ADMIN_TOKEN
 * env var, the same scheme as /v2/admin/mail/send. Sending SMS is abusable
 * (spam / cost / personal number), so the endpoint is fail-closed: when
 * ADMIN_TOKEN is unset it refuses to run.
 *
 * For bulk 명절 인사 to a contact list, use test/sms-local/send-greetings.ts
 * instead — it adds personalization + throttling + a dry-run preview.
 */
import { timingSafeMatch } from "./widget-endpoints";

export const v2SmsEndpoints = async (app: any) => {
  app.group("/v2", (app: any) => {
    app.post(
      "/admin/sms/send",
      async ({
        headers,
        body,
        set,
      }: {
        headers: Record<string, string | undefined>;
        set: { status?: number | string };
        body: {
          to: string;
          text: string;
        };
      }) => {
        const expected = process.env.ADMIN_TOKEN?.trim();
        if (!expected) {
          set.status = 500;
          return {
            success: false,
            error: "ADMIN_TOKEN env var not set on server",
          };
        }
        const token = (headers["x-admin-token"] || "").trim();
        if (!timingSafeMatch(token, expected)) {
          set.status = 401;
          return { success: false, error: "unauthorized" };
        }

        // 전화번호는 공백/하이픈을 제거해 전달 (예: "010-1234-5678" → "01012345678").
        const rawTo = (body?.to ?? "").trim();
        const to = rawTo.replace(/[\s-]/g, "");
        const text = (body?.text ?? "").trim();

        if (!rawTo || !to) {
          set.status = 400;
          return { success: false, error: "to required" };
        }
        if (to.length > 15) {
          set.status = 400;
          return {
            success: false,
            error: "phone number exceeds maximum length of 15 digits",
          };
        }
        if (!/^\+?[0-9]{7,15}$/.test(to)) {
          set.status = 400;
          return { success: false, error: "invalid phone number format" };
        }
        if (!text) {
          set.status = 400;
          return { success: false, error: "text required" };
        }
        if (text.length > 2000) {
          set.status = 400;
          return {
            success: false,
            error: "text exceeds maximum length of 2000 characters",
          };
        }

        if (!isSmsConfigured()) {
          set.status = 500;
          return {
            success: false,
            error: `SMS provider(${activeProvider()}) 환경변수 미설정 — PUSHBULLET_ACCESS_TOKEN 과 (PUSHBULLET_DEVICE_NICKNAME 또는 PUSHBULLET_DEVICE_IDEN) 을 확인하세요.`,
          };
        }

        try {
          const result = await sendSms({ phoneNumber: to, text });
          if (!result.ok) set.status = 502;
          return { success: result.ok, ...result };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[v2/admin/sms/send] failed:", message);
          set.status = 502;
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
