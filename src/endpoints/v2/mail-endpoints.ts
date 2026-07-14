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
        set,
      }: {
        headers: Record<string, string | undefined>;
        set: { status?: number | string };
        body: {
          to: string;
          subject: string;
          text?: string;
          html?: string;
          from?: string;
        };
      }) => {
        // Auth: accept MAIL_SEND_TOKEN (mail-only scope, preferred for the
        // 맥스 routine) or ADMIN_TOKEN (full admin). Fail-closed when neither
        // is configured — sending mail is an abusable capability.
        const mailToken = process.env.MAIL_SEND_TOKEN?.trim();
        const adminToken = process.env.ADMIN_TOKEN?.trim();
        if (!mailToken && !adminToken) {
          set.status = 500;
          return {
            success: false,
            error: "neither MAIL_SEND_TOKEN nor ADMIN_TOKEN is set on server",
          };
        }
        const token = (headers["x-admin-token"] || "").trim();
        const authorized =
          (!!mailToken && token === mailToken) ||
          (!!adminToken && token === adminToken);
        if (!authorized) {
          set.status = 401;
          return { success: false, error: "unauthorized" };
        }

        if (!isNaverMailConfigured()) {
          return {
            success: false,
            error:
              "네이버 SMTP 미설정 — NAVER_ID+NAVER_APP_PASSWORD 또는 NAVER_MAIL_USER+NAVER_MAIL_PASSWORD 환경변수 필요.",
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
        body: t.Object(
          {
            to: t.String({
              description: "받는 사람 이메일 (쉼표로 여러 명 가능)",
            }),
            subject: t.String({ description: "메일 제목" }),
            text: t.Optional(
              t.String({
                description: "텍스트 본문 (text 또는 html 중 하나는 필수)",
              }),
            ),
            html: t.Optional(
              t.String({
                description: "HTML 본문 (text 또는 html 중 하나는 필수)",
              }),
            ),
            from: t.Optional(
              t.String({
                description:
                  "보낸 주소 (생략 시 NAVER_MAIL_USER). 네이버는 보낸 주소가 인증 계정과 같아야 합니다.",
              }),
            ),
          },
          {
            // Scalar/Swagger renders this as the sample request body so the
            // optional `text` field shows up pre-filled (both text+html are
            // optional, so the auto-generated example would otherwise omit it).
            examples: [
              {
                to: "someone@example.com",
                subject: "테스트 메일",
                text: "본문 내용입니다.",
              },
            ],
          },
        ),
        detail: {
          tags: ["API"],
          description:
            "네이버 SMTP로 메일 발송. X-Admin-Token 헤더 필요(서버 MAIL_SEND_TOKEN 또는 ADMIN_TOKEN과 일치). body엔 text 또는 html 중 하나 필수.",
          // Documents the auth header in the API explorer (the handler reads it
          // manually, so this is OpenAPI-only — no runtime validation change).
          parameters: [
            {
              name: "X-Admin-Token",
              in: "header",
              required: true,
              description:
                "인증 토큰 — 서버의 MAIL_SEND_TOKEN(메일 전용) 또는 ADMIN_TOKEN과 일치해야 합니다.",
              schema: { type: "string" },
            },
          ],
        },
      },
    );

    return app;
  });
};
