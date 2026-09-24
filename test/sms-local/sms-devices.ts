/**
 * 발송에 쓸 수 있는 기기/서비스 목록 조회 — 폰을 갈아끼울 때 쓴다. 발송하지 않음.
 *
 *   node --env-file=.env scripts/sms-devices.ts   (= npm run sms:devices)
 *
 * 출력:
 *   1) Pushbullet 에 연결된 안드로이드 기기들 (별명 / iden / 활성상태)
 *      → .env 의 PUSHBULLET_TEST_DEVICE_NICKNAME 또는 PUSHBULLET_PROD_DEVICE_NICKNAME 에 넣을 값
 *   2) 맥 Messages 의 SMS 서비스 (아이폰 문자 메시지 전달)
 *      → .env 의 IMESSAGE_SERVICE_ID 에 넣을 값 (보통 생략해도 됨)
 */
import { spawn } from "node:child_process";
import { getPushbulletConfig } from "../../lib/sms/pushbullet.ts";

async function showPushbullet() {
  const conf = getPushbulletConfig();
  console.log(`📱 Pushbullet 기기 (안드로이드) - 현재 환경: [${conf.mode}]`);
  
  if (!conf.token) {
    console.log(`   PUSHBULLET_${conf.mode}_ACCESS_TOKEN 미설정 — 건너뜀`);
    console.log("   (또는 하위 호환성 PUSHBULLET_ACCESS_TOKEN 미설정)\n");
    return;
  }
  try {
    const res = await fetch("https://api.pushbullet.com/v2/devices", {
      headers: { "access-token": conf.token },
    });
    const data = (await res.json()) as {
      devices?: {
        iden?: string;
        nickname?: string;
        active?: boolean;
        pushable?: boolean;
      }[];
      error?: { message?: string };
    };
    if (data.error) {
      console.log(`   ❌ ${data.error.message}\n`);
      return;
    }
    const devices = (data.devices ?? []).filter((d) => d.active);
    if (devices.length === 0) {
      console.log("   (활성 기기 없음 — 폰에 Pushbullet 설치/로그인 필요)\n");
      return;
    }
    for (const d of devices) {
      const selected =
        d.iden === conf.iden ||
        (!!conf.nickname &&
          d.nickname?.toLowerCase() === conf.nickname.toLowerCase());
      console.log(
        `   ${selected ? "▶" : " "} ${d.nickname ?? "(이름없음)"}` +
          `  iden=${d.iden}  pushable=${d.pushable}${selected ? "   ← 현재 설정" : ""}`,
      );
    }
    console.log(
      `   → 교체하려면 .env 에  PUSHBULLET_${conf.mode}_DEVICE_NICKNAME=<별명>  (또는 _IDEN=<iden>)\n`,
    );
  } catch (e) {
    console.log(`   ❌ 조회 실패: ${e instanceof Error ? e.message : e}\n`);
  }
}

function showMessagesServices(): Promise<void> {
  console.log("🍎 맥 Messages SMS 서비스 (아이폰 문자 메시지 전달)");
  if (process.platform !== "darwin") {
    console.log("   macOS 아님 — 건너뜀");
    return Promise.resolve();
  }
  const script = `tell application "Messages"
	set out to ""
	repeat with a in (every account whose service type is SMS)
		set out to out & (id of a) & "\\n"
	end repeat
	return out
end tell`;
  return new Promise((resolve) => {
    const child = spawn("osascript", ["-"]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", () => resolve());
    child.on("close", () => {
      const ids = stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length === 0) {
        console.log(
          `   ❌ SMS 서비스 없음${stderr.trim() ? ` (${stderr.trim().split("\n")[0]})` : ""}`,
        );
        console.log(
          "   → 아이폰 설정 > 메시지 > 문자 메시지 전달 에서 이 맥을 켜세요.",
        );
      } else {
        const cur = process.env.IMESSAGE_SERVICE_ID?.trim();
        for (const id of ids) {
          console.log(`   ${id === cur ? "▶" : " "} ${id}${id === cur ? "   ← 현재 설정" : ""}`);
        }
        console.log(
          "   → 보통 생략 가능(자동 선택). 고정하려면 .env 에 IMESSAGE_SERVICE_ID=<위 값>",
        );
      }
      resolve();
    });
    child.stdin.write(script);
    child.stdin.end();
  });
}

async function main() {
  console.log(
    `현재 SMS_PROVIDER = ${process.env.SMS_PROVIDER?.trim() || "(미설정 → phone)"}\n`,
  );
  await showPushbullet();
  await showMessagesServices();
}

main().catch((e) => {
  console.error("✗ 조회 중단:", e instanceof Error ? e.message : e);
  process.exit(1);
});
