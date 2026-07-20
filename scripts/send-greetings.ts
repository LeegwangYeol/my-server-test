/**
 * 명절 인사 일괄 발송 — 본인 폰이 보내는 0원 방식 2종을 지원합니다.
 *
 *   SMS_PROVIDER=pushbullet → Pushbullet(Play스토어 정식 앱). 본인 안드로이드폰이
 *                             발송. 무료 계정 월 ~100건 한도 = 100명 배치 딱 1회분.
 *   SMS_PROVIDER=phone      → SMS Gate 게이트웨이(APK 설치). 한도 없음. (기본값)
 *
 *   미리보기(기본):  node --env-file=.env scripts/send-greetings.ts --csv contacts.csv --template greeting.txt
 *   실제 발송:       위 명령에 --send 추가
 *
 * 안전장치: --send 가 없으면 절대 발송하지 않고, 누구에게 어떤 문구가 갈지 미리보기만
 * 합니다(실수로 100명에게 쏘는 사고 방지).
 *
 * CSV 형식: 첫 줄 헤더 `name,phone`, 이후 한 줄에 한 명. 예) 김영자,010-1234-5678
 * 템플릿:   파일 안의 {name} 또는 {이름} 자리에 수신자 이름이 치환됩니다.
 *
 * 발송 간격(throttle): SMS_SEND_DELAY_MS (기본 2000ms). 100명이면 약 3~4분.
 * 한 번에 몰아 쏘면 통신사 스팸필터에 걸리므로 천천히 순차 발송합니다.
 */
// Explicit .ts extensions: run directly by `node --env-file` whose ESM resolver
// won't add them. Both modules have no relative imports, so they resolve cleanly.
// (lib/sms/index.ts is NOT used here on purpose — its extensionless sub-imports
// only resolve under bun/esbuild, not plain node.)
import {
  sendViaPhoneGateway,
  isPhoneGatewayConfigured,
} from "../lib/sms/phone-gateway.ts";
import {
  sendViaPushbullet,
  isPushbulletConfigured,
} from "../lib/sms/pushbullet.ts";
import {
  getCount,
  recordSends,
  freeLimit,
  currentMonth,
} from "../lib/sms/usage.ts";
import { readFileSync } from "node:fs";

const usePushbullet =
  process.env.SMS_PROVIDER?.trim().toLowerCase() === "pushbullet";
const provider = usePushbullet ? "pushbullet" : "phone";

const argv = process.argv.slice(2);
const flagValue = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const hasFlag = (flag: string): boolean => argv.includes(flag);

const csvPath = flagValue("--csv") ?? "contacts.csv";
const templatePath = flagValue("--template") ?? "greeting.txt";
const doSend = hasFlag("--send");
const delayMs = Number(process.env.SMS_SEND_DELAY_MS ?? "2000");

interface Contact {
  name: string;
  phone: string;
}

function parseCsv(text: string): Contact[] {
  const out: Contact[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^name\s*,\s*phone$/i.test(trimmed)) continue; // 헤더 스킵
    const comma = trimmed.indexOf(",");
    if (comma < 0) continue;
    const name = trimmed.slice(0, comma).trim();
    const phone = trimmed.slice(comma + 1).replace(/[\s-]/g, "").trim();
    if (!phone) continue;
    out.push({ name, phone });
  }
  return out;
}

const personalize = (template: string, name: string): string =>
  template.replace(/\{name\}|\{이름\}/g, name);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readOrExit(path: string, label: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    console.error(`✗ ${label} 파일을 읽을 수 없습니다: ${path}`);
    process.exit(1);
  }
}

async function main() {
  const template = readOrExit(templatePath, "템플릿").trim();
  const contacts = parseCsv(readOrExit(csvPath, "연락처 CSV"));

  if (!template) {
    console.error(`✗ 템플릿이 비어 있습니다: ${templatePath}`);
    process.exit(1);
  }
  if (contacts.length === 0) {
    console.error(`✗ 발송 대상이 없습니다 (CSV: ${csvPath})`);
    process.exit(1);
  }

  console.log(
    `대상 ${contacts.length}명 · ${doSend ? "🚀 실제 발송" : "👀 미리보기(dry-run)"} · 경로 ${usePushbullet ? "Pushbullet(본인폰)" : "SMS Gate(폰 게이트웨이)"} · 발송 간격 ${delayMs}ms`,
  );

  // ── 이번 달 발송량(무료 한도) 안내 ──────────────────────────────
  const limit = freeLimit(provider); // pushbullet=100, 그 외 null
  if (limit !== null) {
    const used = getCount(provider);
    const projected = used + contacts.length;
    console.log(
      `이번 달(${currentMonth()}) ${provider} 사용: ${used}/${limit} · 이번 발송 ${contacts.length}건 → 예상 ${projected}/${limit}`,
    );
    if (projected > limit) {
      console.warn(
        `⚠ 이번 발송으로 월 무료 한도(${limit})를 넘깁니다 (예상 ${projected}). 초과분은 발송이 실패할 수 있어요.\n` +
          "  → 다음 달에 나눠 보내거나, SMS_PROVIDER=phone(SMS Gate)로 바꾸면 한도가 없습니다.",
      );
    } else if (projected > limit * 0.9) {
      console.warn(
        `⚠ 월 무료 한도의 90%에 근접합니다 (예상 ${projected}/${limit}).`,
      );
    }
  }
  console.log("─".repeat(56));

  // ── 미리보기 모드 ───────────────────────────────────────────────
  if (!doSend) {
    const preview = contacts.slice(0, 3);
    for (const c of preview) {
      console.log(`▶ ${c.name} (${c.phone})`);
      console.log(personalize(template, c.name));
      console.log("");
    }
    if (contacts.length > preview.length) {
      console.log(`… 외 ${contacts.length - preview.length}명 (동일 형식)`);
    }
    console.log("─".repeat(56));
    console.log("이대로 보내려면 --send 를 붙여 다시 실행하세요:");
    console.log(
      `  node --env-file=.env scripts/send-greetings.ts --csv ${csvPath} --template ${templatePath} --send`,
    );
    return;
  }

  // ── 실제 발송 모드 ──────────────────────────────────────────────
  if (usePushbullet && !isPushbulletConfigured()) {
    console.error(
      "✗ Pushbullet 미설정. .env 에 PUSHBULLET_ACCESS_TOKEN / PUSHBULLET_DEVICE_IDEN 을 넣으세요.\n" +
        "  (pushbullet.com > Settings > Create Access Token, 폰 device iden)",
    );
    process.exit(1);
  }
  if (!usePushbullet && !isPhoneGatewayConfigured()) {
    console.error(
      "✗ 폰 게이트웨이 미설정. .env 에 SMS_GATEWAY_URL / SMS_GATEWAY_USERNAME / " +
        "SMS_GATEWAY_PASSWORD 를 넣으세요. (SMS Gate 앱 'Local server' 화면 값)",
    );
    process.exit(1);
  }

  let success = 0;
  const failures: { name: string; phone: string; error: string }[] = [];

  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i];
    const text = personalize(template, c.name);
    process.stdout.write(`[${i + 1}/${contacts.length}] ${c.name} (${c.phone}) … `);
    try {
      const r = usePushbullet
        ? await sendViaPushbullet({ phoneNumber: c.phone, text })
        : await sendViaPhoneGateway({ phoneNumber: c.phone, text });
      if (r.ok) {
        success++;
        recordSends(provider, 1); // 성공 즉시 매건 기록(중간 크래시 대비)
        console.log(`✓ ${("state" in r ? r.state : undefined) ?? "queued"}`);
      } else {
        failures.push({
          name: c.name,
          phone: c.phone,
          error: `HTTP ${r.status} ${JSON.stringify(r.raw ?? "")}`,
        });
        console.log(`✗ HTTP ${r.status}`);
      }
    } catch (e) {
      failures.push({
        name: c.name,
        phone: c.phone,
        error: e instanceof Error ? e.message : String(e),
      });
      console.log("✗");
    }
    if (i < contacts.length - 1) await sleep(delayMs);
  }

  console.log("─".repeat(56));
  console.log(`완료: 성공 ${success}명 / 실패 ${failures.length}명`);
  if (limit !== null) {
    const nowUsed = getCount(provider);
    console.log(
      `이번 달 ${provider} 누적: ${nowUsed}/${limit} (남은 ${Math.max(0, limit - nowUsed)}건)`,
    );
  }
  if (failures.length > 0) {
    console.log("실패 목록 (재발송 참고):");
    for (const f of failures) console.log(`  - ${f.name} (${f.phone}): ${f.error}`);
    process.exit(2);
  }
}

main().catch((e) => {
  console.error("✗ 발송 중단:", e instanceof Error ? e.message : e);
  process.exit(1);
});
