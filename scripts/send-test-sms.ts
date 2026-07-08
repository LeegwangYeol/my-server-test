/**
 * One-off test harness for the SOLAPI SMS sender.
 *
 *   node --env-file=.env scripts/send-test-sms.ts [recipient]
 *
 * Reads SOLAPI_API_KEY / SOLAPI_API_SECRET / SOLAPI_ADMIN_PHONE_NUMBER from the
 * environment (the --env-file flag loads .env on Node 20.6+), calls sendSms
 * directly — no HTTP server needed — and prints the SOLAPI result. Defaults the
 * recipient to SOLAPI_ADMIN_PHONE_NUMBER (i.e. sends to yourself) when no number
 * is passed on the CLI, which is the safe self-test.
 */
// Explicit .ts extension: this script is run directly by `node --env-file`,
// whose native ESM resolver (unlike bun/esbuild) won't add it for us.
import { sendSms, isSolapiConfigured } from "../lib/sms/solapi.ts";

const to =
  process.argv[2]?.replace(/[\s-]/g, "").trim() ||
  process.env.SOLAPI_ADMIN_PHONE_NUMBER?.trim();

async function main() {
  if (!isSolapiConfigured()) {
    console.error(
      "✗ SOLAPI_API_KEY / SOLAPI_API_SECRET / SOLAPI_ADMIN_PHONE_NUMBER 미설정.\n" +
        "  .env 에 세 값을 넣고, SOLAPI 콘솔에서 발신번호 사전등록을 마친 뒤 다시 실행하세요.\n" +
        "  실행: node --env-file=.env scripts/send-test-sms.ts [수신번호]",
    );
    process.exit(1);
  }
  if (!to) {
    console.error(
      "✗ 수신번호가 없습니다. 인자로 넘기거나 SOLAPI_ADMIN_PHONE_NUMBER 를 설정하세요.\n" +
        "  실행: node --env-file=.env scripts/send-test-sms.ts 01012345678",
    );
    process.exit(1);
  }

  const stamp = new Date().toISOString();
  console.log(`→ sending test SMS to ${to} ...`);
  const result = await sendSms({
    phoneNumber: to,
    text: `[테스트] my-server-test SOLAPI 문자 발송 확인\n발송 시각: ${stamp}`,
  });

  const failed = result.failedMessageList.length;
  console.log(failed === 0 ? "✓ sent" : "✗ some messages failed");
  console.log("  groupId :", result.groupInfo.groupId);
  console.log("  status  :", result.groupInfo.status);
  console.log("  count   :", JSON.stringify(result.groupInfo.count));
  if (failed > 0) {
    console.log("  failed  :", JSON.stringify(result.failedMessageList));
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("✗ send failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
