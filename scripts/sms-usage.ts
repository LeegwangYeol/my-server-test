/**
 * 이번 달 SMS 발송량(무료 한도) 확인 — 발송하지 않습니다.
 *
 *   node --env-file=.env scripts/sms-usage.ts   (= npm run sms:usage)
 */
import { readUsage, currentMonth, freeLimit } from "../lib/sms/usage.ts";

const month = currentMonth();
const usage = readUsage();
const monthData = usage[month] ?? {};

console.log(`📊 이번 달: ${month}`);
const providers = Object.keys(monthData);
if (providers.length === 0) {
  console.log("  (아직 이번 달 발송 기록 없음)");
} else {
  for (const p of providers) {
    const used = monthData[p];
    const limit = freeLimit(p);
    if (limit === null) {
      console.log(`  ${p}: ${used}건 (한도 없음)`);
    } else {
      const remaining = Math.max(0, limit - used);
      const flag = used >= limit ? " ⛔ 한도 초과" : remaining <= limit * 0.1 ? " ⚠ 임박" : "";
      console.log(`  ${p}: ${used}/${limit}건 (남은 ${remaining}건)${flag}`);
    }
  }
}

const past = Object.keys(usage)
  .filter((m) => m !== month)
  .sort()
  .reverse()
  .slice(0, 6);
if (past.length > 0) {
  console.log("지난 기록:");
  for (const m of past) {
    const parts = Object.entries(usage[m])
      .map(([p, n]) => `${p} ${n}`)
      .join(", ");
    console.log(`  ${m}: ${parts}`);
  }
}
