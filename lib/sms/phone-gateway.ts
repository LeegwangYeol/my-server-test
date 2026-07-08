/**
 * SMS via a self-hosted Android phone — "SMS Gate / android-sms-gateway"
 * (https://sms-gate.app) running in **Local mode**.
 *
 * The phone runs a small HTTP server on your LAN; we POST a message and the
 * phone sends it over its OWN carrier plan (한국 요금제 문자 무제한) — so there
 * is no per-message gateway fee. This is the "진짜 0원" path.
 *
 * Env:
 *   SMS_GATEWAY_URL       Address shown on the app's "Local server" screen,
 *                         e.g. http://192.168.0.10:8080  (path optional — we
 *                         default to /message and fall back across app versions)
 *   SMS_GATEWAY_USERNAME  Basic-auth username shown by the app
 *   SMS_GATEWAY_PASSWORD  Basic-auth password shown by the app
 *   SMS_GATEWAY_SIM       optional SIM slot (1 or 2) for dual-SIM phones
 *
 * Import-safe: never throws at module load (mirrors lib/mail/naver.ts), so the
 * app still boots when SMS isn't configured.
 */

// Local-server path differs across app builds; we try these in order on 404.
const COMMON_PATHS = ["/message", "/3rdparty/v1/messages"];

export function isPhoneGatewayConfigured(): boolean {
  return Boolean(
    process.env.SMS_GATEWAY_URL?.trim() &&
      process.env.SMS_GATEWAY_USERNAME?.trim() &&
      process.env.SMS_GATEWAY_PASSWORD?.trim(),
  );
}

export interface PhoneGatewayResult {
  ok: boolean;
  status: number;
  id?: string;
  state?: string;
  raw?: unknown;
}

/** Build the list of endpoint URLs to try, handling app-version path drift. */
function candidateUrls(raw: string): string[] {
  const base = new URL(raw);
  const hasPath = base.pathname && base.pathname !== "/";
  const withPath = (p: string) => {
    const u = new URL(raw);
    u.pathname = p;
    return u.toString();
  };
  if (hasPath) {
    const given = base.toString();
    return [given, ...COMMON_PATHS.map(withPath).filter((u) => u !== given)];
  }
  return COMMON_PATHS.map(withPath);
}

export async function sendViaPhoneGateway({
  phoneNumber,
  text,
}: {
  phoneNumber: string;
  text: string;
}): Promise<PhoneGatewayResult> {
  const url = process.env.SMS_GATEWAY_URL?.trim();
  const user = process.env.SMS_GATEWAY_USERNAME?.trim();
  const pass = process.env.SMS_GATEWAY_PASSWORD?.trim();
  if (!url || !user || !pass) {
    throw new Error(
      "SMS_GATEWAY_URL / SMS_GATEWAY_USERNAME / SMS_GATEWAY_PASSWORD 환경변수가 " +
        "설정되어야 합니다. (SMS Gate 앱의 'Local server' 화면 값)",
    );
  }

  const sim = process.env.SMS_GATEWAY_SIM?.trim();
  const body: Record<string, unknown> = {
    textMessage: { text },
    phoneNumbers: [phoneNumber],
  };
  if (sim) body.simNumber = Number(sim);

  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  const post = (endpoint: string) =>
    fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(body),
    });

  let res: Response | null = null;
  for (const candidate of candidateUrls(url)) {
    res = await post(candidate);
    if (res.status !== 404) break; // 404 → likely wrong path for this app build
  }
  if (!res) throw new Error("no endpoint candidates"); // unreachable

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    /* non-JSON body — leave raw undefined */
  }
  const parsed = raw as { id?: string; state?: string } | undefined;
  return {
    ok: res.ok,
    status: res.status,
    id: parsed?.id,
    state: parsed?.state,
    raw,
  };
}
