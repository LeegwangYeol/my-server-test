import { t } from "elysia";
import { isNaverMailConfigured, sendNaverMail } from "../../../lib/mail/naver";

/**
 * v2 mail endpoints — server-side transactional mail via Naver SMTP.
 *
 *   POST /v2/admin/mail/send  → send an email through smtp.naver.com
 *
 * Auth: shared secret in the `X-Admin-Token` header matching the ADMIN_TOKEN
 * env var, the same scheme as /v2/admin/db/migrate. Sending mail is an
 * abusable capability (open-relay / spam), so the endpoint is fail-closed:
 * when ADMIN_TOKEN is unset it refuses to run.
 */
export const v2MailEndpoints = async (app: any) => {
  app.group("/v2", (app: any) => {
    app.post(
      "/admin/mail/send",
      async ({
        headers,
        body,
      }: {
        headers: Record<string, string | undefined>;
        body: {
          to: string;
          subject: string;
          text?: string;
          html?: string;
          from?: string;
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

        if (!isNaverMailConfigured()) {
          return {
            success: false,
            error:
              "NAVER_MAIL_USER / NAVER_MAIL_PASSWORD 미설정 (네이버 SMTP 사용 설정 필요).",
          };
        }

        const to = (body?.to ?? "").trim();
        const subject = (body?.subject ?? "").trim();
        if (!to) return { success: false, error: "to required" };
        if (!subject) return { success: false, error: "subject required" };
        if (!body?.text && !body?.html) {
          return { success: false, error: "text or html required" };
        }

        try {
          const result = await sendNaverMail({
            to,
            subject,
            text: body.text,
            html: body.html,
            from: body.from,
          });
          return { success: result.rejected.length === 0, ...result };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[v2/admin/mail/send] failed:", message);
          return { success: false, error: message };
        }
      },
      {
        body: t.Object({
          to: t.String(),
          subject: t.String(),
          text: t.Optional(t.String()),
          html: t.Optional(t.String()),
          from: t.Optional(t.String()),
        }),
        detail: { tags: ["API"], description: "Send mail via Naver SMTP" },
      },
    );

    return app;
  });
};
