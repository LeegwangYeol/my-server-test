/**
 * iMessage 경로 **배달 검증** — 맥 메시지 앱 DB(chat.db)를 읽어 실제로 나갔는지 확인한다.
 *
 * 왜 필요한가: AppleScript 는 "메시지 앱에 넣었다"까지만 알려주고 배달 실패(빨간 !)는
 * 알려주지 않는다. 100명 발송에서 몇 명이 조용히 실패해도 모르는 걸 막기 위해,
 * 발송 후 chat.db 의 is_sent / error 컬럼으로 수신자별 상태를 대조한다.
 *
 * 전제: 이 프로세스(터미널)에 macOS **전체 디스크 접근** 권한이 있어야 chat.db 를 읽을 수
 * 있다. 없으면 canReadMessagesDb() 가 false 를 돌려주고, 호출측은 권한 안내만 출력한다.
 * (권한이 없어도 발송 자체는 막지 않는다.)
 *
 * Env:
 *   IMESSAGE_DB_PATH  (선택) chat.db 경로 override — 테스트용. 기본 ~/Library/Messages/chat.db
 *
 * 구현: 네이티브 sqlite 바인딩 대신 macOS 기본 `sqlite3` CLI 를 -json 으로 호출한다.
 * 상대 경로 import 없음 → scripts 에서 `node --env-file` 로 직접 import 가능.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Apple 의 시간 원점(2001-01-01) 과 unix epoch 차이(초). */
const APPLE_EPOCH_OFFSET = 978307200;

export function messagesDbPath(): string {
  return (
    process.env.IMESSAGE_DB_PATH?.trim() ||
    join(homedir(), "Library", "Messages", "chat.db")
  );
}

/** chat.db 를 실제로 읽을 수 있는지 (파일 존재 + 전체 디스크 접근 권한). */
export function canReadMessagesDb(): boolean {
  const db = messagesDbPath();
  if (!existsSync(db)) return false;
  try {
    execFileSync("sqlite3", ["-readonly", db, "SELECT 1 FROM message LIMIT 1;"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 전화번호를 비교용 키로 정규화한다.
 * "+82 10-6491-4081" / "01064914081" / "821064914081" → 모두 "1064914081".
 */
export function normalizePhone(raw: string): string {
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("82")) d = d.slice(2);
  if (d.startsWith("0")) d = d.slice(1);
  return d;
}

export type DeliveryState = "delivered" | "sent" | "failed" | "pending" | "not_found";

export interface DeliveryStatus {
  phone: string;
  state: DeliveryState;
  /** chat.db 의 error 코드 (0 이면 정상). failed 일 때 참고용 */
  error?: number;
  /** 메시지 앱에 기록된 발송 시각 (로컬) */
  at?: string;
}

interface Row {
  dest: string | null;
  is_sent: number;
  is_delivered: number;
  error: number;
  date: number;
}

/**
 * `since`(unix ms) 이후 이 맥에서 나간 메시지들을 읽어, 각 수신자의 최신 상태를 돌려준다.
 * 권한이 없으면 throw 하지 않고 모두 not_found 로 채운다 — 호출측이 canReadMessagesDb()
 * 로 먼저 판단하는 것을 권장.
 */
export function verifyDeliveries(
  recipients: string[],
  sinceUnixMs: number,
): DeliveryStatus[] {
  const db = messagesDbPath();
  // 마진 60초: 발송 직전 시각 기록의 시계 오차 흡수
  const sinceSec = Math.floor(sinceUnixMs / 1000) - 60;

  // date 컬럼은 나노초(최근) 또는 초(옛 행) 단위가 섞여 있어 둘 다 처리한다.
  const sql = `
    SELECT h.id AS dest, m.is_sent, m.is_delivered, m.error,
      CASE WHEN m.date > 1000000000000 THEN m.date/1000000000 ELSE m.date END + ${APPLE_EPOCH_OFFSET} AS date
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    WHERE m.is_from_me = 1
      AND (CASE WHEN m.date > 1000000000000 THEN m.date/1000000000 ELSE m.date END + ${APPLE_EPOCH_OFFSET}) >= ${sinceSec}
    ORDER BY m.date DESC;`;

  let rows: Row[] = [];
  try {
    const out = execFileSync("sqlite3", ["-readonly", "-json", db, sql], {
      encoding: "utf8",
      timeout: 15000,
    });
    rows = out.trim() ? (JSON.parse(out) as Row[]) : [];
  } catch {
    return recipients.map((phone) => ({ phone, state: "not_found" }));
  }

  // 수신자별 최신 행 하나만 (ORDER BY date DESC 라 첫 매치가 최신)
  const latestByKey = new Map<string, Row>();
  for (const r of rows) {
    if (!r.dest) continue;
    const key = normalizePhone(r.dest);
    if (!latestByKey.has(key)) latestByKey.set(key, r);
  }

  return recipients.map((phone) => {
    const r = latestByKey.get(normalizePhone(phone));
    if (!r) return { phone, state: "not_found" };
    const at = new Date(r.date * 1000).toLocaleString("ko-KR");
    if (r.error && r.error !== 0) return { phone, state: "failed", error: r.error, at };
    if (r.is_delivered === 1) return { phone, state: "delivered", at };
    if (r.is_sent === 1) return { phone, state: "sent", at };
    return { phone, state: "pending", at };
  });
}

export const STATE_LABEL: Record<DeliveryState, string> = {
  delivered: "✅ 배달됨",
  sent: "✓ 전송됨",
  failed: "❌ 전송 안 됨",
  pending: "⏳ 대기중",
  not_found: "? 기록없음",
};
