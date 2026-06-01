/**
 * One-off test harness for the Naver SMTP sender.
 *
 *   node --env-file=.env scripts/send-test-mail.ts [recipient]
 *
 * Reads NAVER_MAIL_USER / NAVER_MAIL_PASSWORD from the environment (the
 * --env-file flag loads .env on Node 20.6+), calls sendNaverMail directly —
 * no HTTP server needed — and prints the SMTP result. Defaults the recipient
 * to bpscokr003@naver.com when none is passed on the CLI.
 */
// Explicit .ts extension: this script is run directly by `node --env-file`,
// whose native ESM resolver (unlike bun/esbuild) won't add it for us.
import { sendNaverMail, isNaverMailConfigured } from "../lib/mail/naver.ts";

const to = process.argv[2]?.trim() || "bpscokr003@naver.com";

async function main() {
  if (!isNaverMailConfigured()) {
    console.error(
      "✗ NAVER_MAIL_USER / NAVER_MAIL_PASSWORD 미설정.\n" +
        "  .env 에 두 값을 넣고, 네이버 메일에서 IMAP/SMTP 사용을 켠 뒤 다시 실행하세요.\n" +
        "  실행: node --env-file=.env scripts/send-test-mail.ts",
    );
    process.exit(1);
  }

  const stamp = new Date().toISOString();
  console.log(`→ sending test mail to ${to} ...`);
  const result = await sendNaverMail({
    to,
    subject: `[테스트] Naver SMTP 발송 확인 (${stamp})`,
    text:
      "이 메일은 my-server-test 의 네이버 SMTP 발송 API 동작 확인용 테스트 메일입니다.\n" +
      `발송 시각: ${stamp}\n`,
    html:
      "<p>이 메일은 <b>my-server-test</b> 의 네이버 SMTP 발송 API 동작 확인용 테스트 메일입니다.</p>" +
      `<p>발송 시각: ${stamp}</p>`,
  });

  console.log("✓ sent");
  console.log("  messageId:", result.messageId);
  console.log("  accepted :", result.accepted.join(", ") || "(none)");
  if (result.rejected.length > 0) {
    console.log("  rejected :", result.rejected.join(", "));
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("✗ send failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
