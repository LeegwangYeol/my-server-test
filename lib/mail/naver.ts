/**
 * Naver SMTP mail sender.
 *
 * Sends through Naver's SMTP gateway (smtp.naver.com:465, implicit TLS)
 * with nodemailer. Credentials come from the environment:
 *
 *   NAVER_MAIL_USER      full Naver address used to authenticate AND as the
 *                        default From header (e.g. "yourid@naver.com")
 *   NAVER_MAIL_PASSWORD  the account password — Naver requires IMAP/SMTP to
 *                        be turned on under 메일 > 환경설정 > POP3/IMAP 설정
 *                        (and, if 2FA is on, an app password)
 *   NAVER_MAIL_FROM_NAME optional display name shown on the From header
 *
 * The transporter is created lazily on first send, so importing this module
 * never throws — the widget app must still boot when mail isn't configured.
 */
import nodemailer, { type Transporter } from "nodemailer";

const SMTP_HOST = "smtp.naver.com";
const SMTP_PORT = 465; // implicit TLS

let cached: Transporter | null = null;

function getTransporter(): Transporter {
  if (cached) return cached;
  const user = process.env.NAVER_MAIL_USER?.trim();
  const pass = process.env.NAVER_MAIL_PASSWORD;
  if (!user || !pass) {
    throw new Error(
      "NAVER_MAIL_USER / NAVER_MAIL_PASSWORD 환경변수가 설정되어야 합니다. " +
        "네이버 메일 > 환경설정 > POP3/IMAP 설정에서 'SMTP 사용'도 켜져 있어야 합니다.",
    );
  }
  cached = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: true,
    auth: { user, pass },
  });
  return cached;
}

export interface SendMailInput {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  /** Override the From header. Defaults to NAVER_MAIL_USER (+ optional name). */
  from?: string;
}

export interface SendMailResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
}

/** True when the required Naver mail env vars are present. */
export function isNaverMailConfigured(): boolean {
  return Boolean(
    process.env.NAVER_MAIL_USER?.trim() && process.env.NAVER_MAIL_PASSWORD,
  );
}

export async function sendNaverMail(
  input: SendMailInput,
): Promise<SendMailResult> {
  if (!input.text && !input.html) {
    throw new Error("text 또는 html 중 하나는 반드시 포함해야 합니다.");
  }

  const transporter = getTransporter();
  const user = process.env.NAVER_MAIL_USER!.trim();
  const fromName = process.env.NAVER_MAIL_FROM_NAME?.trim();
  // Naver rejects a From that doesn't match the authenticated account, so we
  // only ever vary the display name — the address stays NAVER_MAIL_USER.
  const defaultFrom = fromName ? `${fromName} <${user}>` : user;

  const info = await transporter.sendMail({
    from: input.from?.trim() || defaultFrom,
    to: Array.isArray(input.to) ? input.to.join(", ") : input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
  });

  return {
    messageId: info.messageId,
    accepted: (info.accepted ?? []).map(String),
    rejected: (info.rejected ?? []).map(String),
  };
}
