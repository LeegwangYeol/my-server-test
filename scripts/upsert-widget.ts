/**
 * 위젯 등록/수정 CLI — widget master 테이블 관리 (/v2/admin/widgets/*).
 *
 * /v2/ask 는 이제 widget master 에 등록된 widget_id 만 허용한다(화이트리스트).
 * 미등록 widget_id 는 403 이 되므로, 실제로 쓰는 위젯은 이 스크립트로 먼저
 * 등록해야 한다. 현재 무엇이 등록/활동 중인지도 --list 로 확인할 수 있다.
 *
 * 인증: ADMIN_TOKEN 환경변수 필요 (서버의 ADMIN_TOKEN 과 일치해야 함).
 *
 * 현황 확인 (등록/미등록 위젯 목록):
 *   ADMIN_TOKEN=xxx node --env-file=.env scripts/upsert-widget.ts --list
 *
 * 등록 / 수정 (넘긴 필드만 반영됨):
 *   ADMIN_TOKEN=xxx node --env-file=.env scripts/upsert-widget.ts \
 *     --id my-widget \
 *     --name "고객봇" \
 *     --welcome "안녕하세요! 무엇이든 물어보세요" \
 *     --system-prompt "너는 친절한 상담원이야. 한국어로 짧게 답해." \
 *     --questions "가격이 궁금해요|환불 정책은?|배송 얼마나 걸려요?"
 *
 * 대상 서버: 기본 https://my-server-test.vercel.app — --base https://... 로 변경.
 */

const argv = process.argv.slice(2);
const flag = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (f: string): boolean => argv.includes(f);

const BASE = (
  flag("--base") ??
  process.env.BASE_URL ??
  "https://my-server-test.vercel.app"
).replace(/\/$/, "");
const TOKEN = process.env.ADMIN_TOKEN?.trim();

if (!TOKEN) {
  console.error(
    "❌ ADMIN_TOKEN 환경변수가 필요합니다 (서버의 ADMIN_TOKEN 과 일치).\n" +
      "   예: ADMIN_TOKEN=xxx node --env-file=.env scripts/upsert-widget.ts --list",
  );
  process.exit(1);
}

const api = async (path: string, body: unknown) => {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": TOKEN! },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
};

const main = async () => {
  // ── 현황 조회 ──
  if (has("--list")) {
    const { status, json } = await api("/v2/admin/widgets", {});
    if (status !== 200) {
      console.error(`❌ 목록 조회 실패 [${status}]:`, JSON.stringify(json));
      process.exit(1);
    }
    const widgets: any[] = json.widgets ?? [];
    console.log(`\n위젯 ${widgets.length}개 (${BASE}):\n`);
    for (const w of widgets) {
      const reg = w.registered ? "✓ 등록  " : "· 미등록";
      console.log(
        `  ${reg}  ${w.widget_id}  (${w.name ?? "-"})  threads=${w.thread_count ?? 0}`,
      );
    }
    console.log(
      "\n※ '미등록'은 대화 기록만 있고 widget master 행이 없는 상태입니다.\n" +
        "  이제 /v2/ask 에서 403 이 되므로, 계속 쓰려면 --id 로 등록하세요.\n",
    );
    return;
  }

  // ── 등록 / 수정 ──
  const id = flag("--id");
  if (!id) {
    console.error(
      "❌ --id <widget_id> 가 필요합니다 (또는 --list 로 현황 확인).\n" +
        "   자세한 사용법은 이 파일 상단 주석을 참고하세요.",
    );
    process.exit(1);
  }

  const questionsRaw = flag("--questions");
  const body: Record<string, unknown> = {
    id,
    name: flag("--name"),
    theme: flag("--theme"),
    description: flag("--desc"),
    welcome_message: flag("--welcome"),
    system_prompt: flag("--system-prompt"),
    suggested_questions: questionsRaw
      ? questionsRaw
          .split("|")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
  };
  // upsert 는 넘긴 필드만 반영하므로 undefined 는 제거한다.
  for (const k of Object.keys(body)) {
    if (body[k] === undefined) delete body[k];
  }

  console.log(`\n→ POST ${BASE}/v2/admin/widgets/upsert`);
  console.log("  payload:", JSON.stringify(body, null, 2));
  const { status, json } = await api("/v2/admin/widgets/upsert", body);
  if (status === 200 && json?.success) {
    console.log(`\n✓ 등록/수정 완료: widget_id="${id}"\n`);
  } else {
    console.error(`\n❌ 실패 [${status}]:`, JSON.stringify(json), "\n");
    process.exit(1);
  }
};

main().catch((e) => {
  console.error("❌", e?.message ?? e);
  process.exit(1);
});
