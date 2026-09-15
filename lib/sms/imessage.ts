/**
 * SMS via the Mac's **Messages.app** using the user's own iPhone
 * ("문자 메시지 전달" / Text Message Forwarding).
 *
 * 왜 필요한가: Pushbullet 은 안드로이드 전용이라, 본인 폰이 아이폰이면 못 쓴다.
 * 이 경로는 맥 기본 메시지 앱을 아이폰의 셀룰러 회선으로 중계시켜 **녹색 SMS**를
 * 보낸다 → 수신자가 안드로이드(어르신 대부분)여도 정상 도착. 요금제 문자무제한이면 0원.
 *
 * Env:
 *   IMESSAGE_SERVICE_ID   (선택) 사용할 Messages 계정 id. 미지정 시 첫 SMS 서비스 자동 선택.
 *                         조회: npm run sms:devices
 *   IMESSAGE_SEND_TIMEOUT_MS (선택) osascript 타임아웃. 기본 30000.
 *
 * 전제 조건 (사용자 1회 설정):
 *   1) 아이폰 설정 > 메시지 > 문자 메시지 전달 에서 이 맥을 켜기
 *   2) 맥에 Messages 자동화 권한 허용 (첫 실행 시 프롬프트)
 *   3) 발송 중 아이폰이 켜져 있고 네트워크 연결 유지
 *
 * ⚠️ 이 경로는 **맥 로컬에서만** 동작한다(osascript 필요). Vercel 등 서버에서는 못 쓴다.
 *
 * 보안: 전화번호·본문을 AppleScript 문자열에 절대 보간하지 않는다. `osascript - a b`
 * 형태로 **argv 인자**로 넘겨 인젝션(따옴표·백슬래시·개행)을 원천 차단한다.
 *
 * Import-safe: 모듈 로드 시 절대 throw 하지 않는다 (다른 sender 들과 동일 원칙).
 * 상대 경로 import 없음 → scripts 에서 `node --env-file` 로 직접 import 가능.
 */
import { spawn } from "node:child_process";

/** argv 로 값을 받으므로 스크립트 본문에 사용자 입력이 섞이지 않는다. */
const APPLESCRIPT = `on run argv
	set phoneNum to item 1 of argv
	set msgText to item 2 of argv
	set svcId to item 3 of argv
	tell application "Messages"
		if svcId is "" then
			set svc to 1st account whose service type is SMS
		else
			set svc to account id svcId
		end if
		send msgText to participant phoneNum of svc
	end tell
end run`;

export function isIMessageConfigured(): boolean {
  // 맥 + Messages 자동화만 있으면 되므로 별도 자격증명이 없다.
  // 실제 가용성은 발송 시점에 osascript 가 알려준다.
  return process.platform === "darwin";
}

export interface IMessageResult {
  ok: boolean;
  /** osascript 종료 코드 (0 = 성공) */
  status: number;
  raw?: unknown;
}

export async function sendViaIMessage({
  phoneNumber,
  text,
}: {
  phoneNumber: string;
  text: string;
}): Promise<IMessageResult> {
  if (process.platform !== "darwin") {
    throw new Error(
      "iMessage 경로는 macOS 에서만 동작합니다 (osascript 필요). " +
        "서버에서 보내려면 SMS_PROVIDER=pushbullet 을 쓰세요.",
    );
  }

  const serviceId = process.env.IMESSAGE_SERVICE_ID?.trim() ?? "";
  const timeoutMs = Number(process.env.IMESSAGE_SEND_TIMEOUT_MS ?? "30000");

  return await new Promise<IMessageResult>((resolve, reject) => {
    // "-" = 스크립트를 stdin 으로 읽고, 뒤 인자들을 argv 로 전달
    const child = spawn("osascript", ["-", phoneNumber, text, serviceId]);
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `osascript 응답 없음 (${timeoutMs}ms 초과). 아이폰이 켜져 있고 문자 메시지 전달이 활성인지 확인하세요.`,
        ),
      );
    }, timeoutMs);

    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const status = code ?? -1;
      if (status === 0) {
        resolve({ ok: true, status });
      } else {
        // 권한 거부(-1743) 등 자주 나오는 원인을 사람이 읽을 수 있게 덧붙인다.
        const hint = /-1743|not allowed|권한/.test(stderr)
          ? " → 시스템 설정 > 개인정보 보호 및 보안 > 자동화 에서 터미널의 '메시지' 제어를 허용하세요."
          : "";
        resolve({
          ok: false,
          status,
          raw: (stderr.trim() || `exit ${status}`) + hint,
        });
      }
    });

    child.stdin.write(APPLESCRIPT);
    child.stdin.end();
  });
}
