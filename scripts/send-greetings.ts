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
  sendViaIMessage,
  isIMessageConfigured,
} from "../lib/sms/imessage.ts";
import {
  canReadMessagesDb,
  verifyDeliveries,
  STATE_LABEL,
} from "../lib/sms/imessage-verify.ts";
import {
  getCount,
  recordSends,
  freeLimit,
  currentMonth,
} from "../lib/sms/usage.ts";
import { readFileSync } from "node:fs";

// 발송 경로 3종. 폰을 갈아끼울 때는 .env 의 SMS_PROVIDER 만 바꾸면 된다.
//   pushbullet → 안드로이드폰(본인/가족) 경유. 기기는 IDEN 또는 NICKNAME 으로 지정
//   imessage   → 맥 메시지앱 + 본인 아이폰(문자 메시지 전달). 맥 로컬 전용
//   phone      → SMS Gate 게이트웨이 앱(APK). 기본값
const rawProvider = process.env.SMS_PROVIDER?.trim().toLowerCase();
const provider: "pushbullet" | "imessage" | "phone" =
  rawProvider === "pushbullet"
    ? "pushbullet"
    : rawProvider === "imessage"
      ? "imessage"
      : "phone";

const PROVIDER_LABEL = {
  pushbullet: "Pushbullet(안드로이드폰)",
  imessage: "iMessage(맥+아이폰 문자전달)",
  phone: "SMS Gate(폰 게이트웨이)",
} as const;

const isConfiguredFor = {
  pushbullet: isPushbulletConfigured,
  imessage: isIMessageConfigured,
  phone: isPhoneGatewayConfigured,
} as const;

const CONFIG_HINT = {
  pushbullet:
    "PUSHBULLET_ACCESS_TOKEN 과 (PUSHBULLET_DEVICE_IDEN 또는 PUSHBULLET_DEVICE_NICKNAME) 을 .env 에 넣으세요.\n  목록 확인: npm run sms:devices",
  imessage:
    "iMessage 경로는 macOS 에서만 동작합니다. 아이폰 설정 > 메시지 > 문자 메시지 전달에서 이 맥을 켜고,\n  맥에 Messages 자동화 권한을 허용하세요. 확인: npm run sms:devices",
  phone:
    "SMS_GATEWAY_URL / SMS_GATEWAY_USERNAME / SMS_GATEWAY_PASSWORD 를 .env 에 넣으세요. (SMS Gate 앱 'Local server' 화면 값)",
} as const;

const sendOne = {
  pushbullet: sendViaPushbullet,
  imessage: sendViaIMessage,
  phone: sendViaPhoneGateway,
} as const;

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
// 명단 분할: --limit N (이번에 몇 명) / --skip N (앞에서 몇 명 건너뛰기).
// 100명을 30명씩 나눠 보내면 통신사 스팸 차단 위험이 줄고, 중간 점검이 가능하다.
const batchLimit = flagValue("--limit") ? Number(flagValue("--limit")) : Infinity;
const batchSkip = flagValue("--skip") ? Number(flagValue("--skip")) : 0;
if (
  !Number.isInteger(batchSkip) ||
  batchSkip < 0 ||
  (batchLimit !== Infinity && (!Number.isInteger(batchLimit) || batchLimit <= 0))
) {
  console.error("✗ --limit 은 1 이상, --skip 은 0 이상의 정수여야 합니다.");
  process.exit(1);
}

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
  const allContacts = parseCsv(readOrExit(csvPath, "연락처 CSV"));

  if (!template) {
    console.error(`✗ 템플릿이 비어 있습니다: ${templatePath}`);
    process.exit(1);
  }
  if (allContacts.length === 0) {
    console.error(`✗ 발송 대상이 없습니다 (CSV: ${csvPath})`);
    process.exit(1);
  }
  // --skip / --limit 적용. 미리보기(dry-run)에도 똑같이 적용돼 묶음 단위로 확인 가능.
  const contacts = allContacts.slice(
    batchSkip,
    batchLimit === Infinity ? undefined : batchSkip + batchLimit,
  );
  if (contacts.length === 0) {
    console.error(
      `✗ --skip ${batchSkip} 이후 대상이 없습니다 (전체 ${allContacts.length}명)`,
    );
    process.exit(1);
  }
  if (batchSkip > 0 || batchLimit !== Infinity) {
    const end = batchSkip + contacts.length;
    console.log(
      `📦 명단 분할: 전체 ${allContacts.length}명 중 ${batchSkip + 1}~${end}번째 (${contacts.length}명)` +
        (end < allContacts.length ? ` · 다음 묶음: --skip ${end}` : " · 마지막 묶음"),
    );
  }

  console.log(
    `대상 ${contacts.length}명 · ${doSend ? "🚀 실제 발송" : "👀 미리보기(dry-run)"} · 경로 ${PROVIDER_LABEL[provider]} · 발송 간격 ${delayMs}ms`,
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
  if (!isConfiguredFor[provider]()) {
    console.error(
      `✗ ${PROVIDER_LABEL[provider]} 경로가 설정되지 않았습니다.\n  ${CONFIG_HINT[provider]}`,
    );
    process.exit(1);
  }

  const sendStartedAt = Date.now(); // 배달 검증 시 이 시각 이후 메시지만 대조
  let success = 0;
  const failures: { name: string; phone: string; error: string }[] = [];

  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i];
    const text = personalize(template, c.name);
    process.stdout.write(`[${i + 1}/${contacts.length}] ${c.name} (${c.phone}) … `);
    try {
      const r = await sendOne[provider]({ phoneNumber: c.phone, text });
      if (r.ok) {
        success++;
        recordSends(provider, 1); // 성공 즉시 매건 기록(중간 크래시 대비)
        // imessage 는 "메시지앱 접수"까지만 확인된다(배달 보장 아님) → 표시를 구분한다.
        const label =
          ("deliveryConfirmed" in r && r.deliveryConfirmed === false)
            ? "접수(배달 미확인)"
            : (("state" in r ? r.state : undefined) ?? "queued");
        console.log(`✓ ${label}`);
      } else {
        // imessage 는 osascript 종료코드, 나머지는 HTTP 상태코드 — 표기를 구분한다.
        const codeLabel =
          provider === "imessage" ? `exit ${r.status}` : `HTTP ${r.status}`;
        failures.push({
          name: c.name,
          phone: c.phone,
          error: `${codeLabel} ${JSON.stringify(r.raw ?? "")}`,
        });
        console.log(`✗ ${codeLabel}`);
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
  console.log(`완료: 접수 ${success}명 / 실패 ${failures.length}명`);
  if (provider === "imessage") {
    if (canReadMessagesDb()) {
      // 배달은 비동기라 잠깐 기다린 뒤 메시지 앱 DB(chat.db)로 실제 결과를 대조한다.
      const settleMs = Number(process.env.IMESSAGE_VERIFY_WAIT_MS ?? "8000");
      console.log(`⏳ 배달 결과 확인 중… (${settleMs / 1000}초 대기)`);
      await sleep(settleMs);
      const results = verifyDeliveries(
        contacts.map((c) => c.phone),
        sendStartedAt,
      );
      const failed: string[] = [];
      const unsettled: string[] = [];
      for (let i = 0; i < contacts.length; i++) {
        const r = results[i];
        const who = `${contacts[i].name} (${contacts[i].phone})`;
        if (r.state === "failed") failed.push(`${who} error=${r.error}`);
        else if (r.state === "pending" || r.state === "not_found")
          unsettled.push(`${who} ${STATE_LABEL[r.state]}`);
      }
      const okCount = results.filter(
        (r) => r.state === "delivered" || r.state === "sent",
      ).length;
      console.log(
        `📬 배달 확인: 정상 ${okCount} · 전송 안 됨 ${failed.length} · 미확정 ${unsettled.length}`,
      );
      if (failed.length) {
        console.log("❌ 전송 안 됨 — 재발송 필요:");
        for (const f of failed) console.log(`  - ${f}`);
      }
      if (unsettled.length) {
        console.log(
          `⏳ 아직 확정 안 됨 — 잠시 후 재확인:  npm run sms:verify -- --csv ${csvPath}`,
        );
        for (const u of unsettled) console.log(`  - ${u}`);
      }
    } else {
      console.warn(
        "⚠️ iMessage 배달 결과를 자동 확인하지 못했습니다 — 터미널에 '전체 디스크 접근' 권한이 없습니다.\n" +
          "   시스템 설정 > 개인정보 보호 및 보안 > 전체 디스크 접근 > 터미널 켜기 → 터미널 재시작 후\n" +
          `   npm run sms:verify -- --csv ${csvPath}  로 누가 실패했는지 확인하세요.\n` +
          "   지금은 메시지 앱에서 빨간 ! (전송 안 됨) 표시를 직접 확인해주세요.\n" +
          "   참고: 중계 중인 아이폰 '본인 번호'로는 배달되지 않습니다.",
      );
    }
  }
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
