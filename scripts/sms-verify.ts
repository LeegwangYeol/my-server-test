/**
 * iMessage 발송 결과 재확인 — 발송 후 나중에라도 누가 실패했는지 명단으로 뽑는다.
 *
 *   node --env-file=.env scripts/sms-verify.ts --csv contacts.csv [--since 30m]
 *   (= npm run sms:verify -- --csv contacts.csv --since 30m)
 *
 * --since : 얼마 전 이후의 발송을 볼지. 30m / 2h / 1d 형식. 기본 60m.
 *
 * 전제: 터미널에 macOS "전체 디스크 접근" 권한 (chat.db 읽기).
 */
import { readFileSync } from "node:fs";
import {
  canReadMessagesDb,
  verifyDeliveries,
  STATE_LABEL,
  messagesDbPath,
} from "../lib/sms/imessage-verify.ts";

const argv = process.argv.slice(2);
const flag = (f: string) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

const csvPath = flag("--csv") ?? "contacts.csv";
const sinceRaw = flag("--since") ?? "60m";

function parseSince(s: string): number {
  const m = /^(\d+)\s*([mhd])$/i.exec(s.trim());
  if (!m) throw new Error(`--since 형식 오류: "${s}" (예: 30m, 2h, 1d)`);
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const ms = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return Date.now() - n * ms;
}

function parseCsv(text: string): { name: string; phone: string }[] {
  const out: { name: string; phone: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /^name\s*,\s*phone$/i.test(t)) continue;
    const c = t.indexOf(",");
    if (c < 0) continue;
    const phone = t.slice(c + 1).replace(/[\s-]/g, "").trim();
    if (phone) out.push({ name: t.slice(0, c).trim(), phone });
  }
  return out;
}

function main() {
  if (!canReadMessagesDb()) {
    console.error(
      `✗ 메시지 DB를 읽을 수 없습니다: ${messagesDbPath()}\n` +
        "  터미널에 '전체 디스크 접근' 권한이 필요합니다:\n" +
        "  시스템 설정 > 개인정보 보호 및 보안 > 전체 디스크 접근 > 터미널(또는 Claude) 켜기 → 터미널 재시작",
    );
    process.exit(1);
  }

  const contacts = parseCsv(readFileSync(csvPath, "utf8"));
  if (contacts.length === 0) {
    console.error(`✗ 대상 없음 (CSV: ${csvPath})`);
    process.exit(1);
  }

  const since = parseSince(sinceRaw);
  const results = verifyDeliveries(
    contacts.map((c) => c.phone),
    since,
  );

  console.log(`📬 최근 ${sinceRaw} 이내 발송 결과 · 대상 ${contacts.length}명`);
  console.log("─".repeat(56));
  const failed: string[] = [];
  const missing: string[] = [];
  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i];
    const r = results[i];
    console.log(`  ${STATE_LABEL[r.state].padEnd(10)} ${c.name} (${c.phone})${r.at ? `  ${r.at}` : ""}`);
    if (r.state === "failed") failed.push(`${c.name} (${c.phone})`);
    if (r.state === "not_found") missing.push(`${c.name} (${c.phone})`);
  }
  console.log("─".repeat(56));
  const ok = results.filter((r) => r.state === "delivered" || r.state === "sent").length;
  console.log(`정상 ${ok} · 실패 ${failed.length} · 기록없음 ${missing.length} · 대기 ${results.filter((r) => r.state === "pending").length}`);
  if (failed.length) {
    console.log("\n❌ 재발송 필요:");
    for (const f of failed) console.log(`  - ${f}`);
  }
  if (missing.length) {
    console.log("\n? 기록 없음 (발송 자체가 안 됐거나 --since 범위 밖):");
    for (const m of missing) console.log(`  - ${m}`);
  }
  process.exit(failed.length > 0 ? 2 : 0);
}

main();
