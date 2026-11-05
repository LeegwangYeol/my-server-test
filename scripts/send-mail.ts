/**
 * General-purpose Naver SMTP sender for agents and scripts.
 *
 *   node --no-warnings --env-file=.env scripts/send-mail.ts --subject "제목" --text "본문"
 *   node --no-warnings --env-file=.env scripts/send-mail.ts --subject "제목" --text-file body.txt
 *   echo 본문 | node --no-warnings --env-file=.env scripts/send-mail.ts --subject "제목" --text-file -
 *
 * Options: --to (defaults to the sending account, i.e. the owner), --subject (required),
 * --text / --text-file, --html / --html-file (at least one body). "-" as a file reads stdin.
 * Prints one JSON line to stdout. Exit 0 = sent, 1 = config/SMTP/usage error, 2 = recipient rejected.
 */
// Explicit .ts extension: run directly by `node --env-file`, whose native ESM
// resolver won't add it for us.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { sendNaverMail, isNaverMailConfigured } from "../lib/mail/naver.ts";

function fail(error: string, code = 1): never {
  console.log(JSON.stringify({ success: false, error }));
  process.exit(code);
}

// INFO : "-" maps to fd 0 so long or multi-line bodies can be piped in instead of
//   squeezed through shell quoting
function readBody(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  try {
    return readFileSync(path === "-" ? 0 : path, "utf8");
  } catch (err) {
    fail(`파일 읽기 실패: ${path} (${err instanceof Error ? err.message : String(err)})`);
  }
}

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      to: { type: "string" },
      subject: { type: "string" },
      text: { type: "string" },
      "text-file": { type: "string" },
      html: { type: "string" },
      "html-file": { type: "string" },
    },
    strict: true,
  }));
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

if (!isNaverMailConfigured()) {
  fail("네이버 SMTP 미설정 — .env 에 NAVER_MAIL_USER / NAVER_MAIL_PASSWORD 필요");
}

const naverId = process.env.NAVER_ID?.trim();
const owner =
  process.env.NAVER_MAIL_USER?.trim() ||
  (naverId ? (naverId.includes("@") ? naverId : `${naverId}@naver.com`) : "");
const to = args.to?.trim() || owner;
const subject = args.subject?.trim();
const text = args.text ?? readBody(args["text-file"]);
const html = args.html ?? readBody(args["html-file"]);

if (!subject) fail("--subject 필요");
if (!text && !html) fail("--text / --text-file / --html / --html-file 중 하나 필요");

try {
  // INFO : the fallback queue is in-memory, so a queued job would die with this
  //   short-lived process while reporting success — fail loudly instead
  const result = await sendNaverMail({ to, subject, text, html }, { allowQueue: false });
  const success = result.rejected.length === 0;
  console.log(JSON.stringify({ success, ...result }));
  process.exit(success ? 0 : 2);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
