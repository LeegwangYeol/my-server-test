/**
 * 로컬 SMS 발송량 카운터 — Pushbullet 무료 "월 100건" 한도 관리용.
 *
 * 월(YYYY-MM)·provider별 발송 성공 건수를 JSON 파일에 누적한다. 전화번호 등
 * 개인정보는 저장하지 않는다(순수 카운트만).
 *
 *   파일 위치: SMS_USAGE_FILE env 또는 기본 <cwd>/.sms-usage.json (gitignore됨)
 *   한도:      PUSHBULLET_FREE_LIMIT env 또는 기본 100 (pushbullet 전용)
 *
 * ⚠️ 한계: 이 파일은 "이 컴퓨터에서 보낸 것"만 센다(Pushbullet은 사용량 조회
 * API가 없어 로컬 추정). 월 경계는 로컬 타임존 기준 달력상 월 근사라 Pushbullet
 * 실제 리셋과 다를 수 있으니 여유(≈90건)를 두는 걸 권장.
 *
 * import-safe: 읽기/쓰기 실패해도 절대 throw하지 않는다(발송을 막지 않기 위해).
 * node 빌트인만 사용 — scripts에서 `node --env-file`로 직접 import 가능.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** { "2026-07": { "pushbullet": 12 }, ... } */
export type UsageData = Record<string, Record<string, number>>;

const DEFAULT_LIMIT = 100;

function filePath(): string {
  return (
    process.env.SMS_USAGE_FILE?.trim() ||
    resolve(process.cwd(), ".sms-usage.json")
  );
}

/** 현재 월 키 (로컬 타임존 기준, 예: "2026-07"). */
export function currentMonth(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** pushbullet 무료 한도(월). 그 외 provider는 한도 없음(null). */
export function freeLimit(provider: string): number | null {
  if (provider !== "pushbullet") return null;
  const raw = process.env.PUSHBULLET_FREE_LIMIT?.trim();
  const n = raw ? Number(raw) : DEFAULT_LIMIT;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMIT;
}

export function readUsage(): UsageData {
  try {
    const data = JSON.parse(readFileSync(filePath(), "utf8"));
    return data && typeof data === "object" ? (data as UsageData) : {};
  } catch {
    return {}; // 파일 없음/깨짐 → 빈 상태로 시작
  }
}

/** 해당 월·provider의 현재 카운트. */
export function getCount(provider: string, month = currentMonth()): number {
  return readUsage()[month]?.[provider] ?? 0;
}

/**
 * 성공 발송 n건을 기록하고 갱신된 월 카운트를 반환.
 * 쓰기 실패 시 stderr 경고만 남기고 계산값을 반환(throw 안 함).
 */
export function recordSends(
  provider: string,
  n = 1,
  month = currentMonth(),
): number {
  const data = readUsage();
  const monthData = data[month] ?? (data[month] = {});
  const next = (monthData[provider] ?? 0) + n;
  monthData[provider] = next;
  try {
    writeFileSync(filePath(), JSON.stringify(data, null, 2) + "\n", "utf8");
  } catch (e) {
    console.warn(
      `⚠ 발송량 카운터 저장 실패(${filePath()}): ${
        e instanceof Error ? e.message : e
      }`,
    );
  }
  return next;
}
