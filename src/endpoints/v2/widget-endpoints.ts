import { t } from "elysia";

/**
 * v2 widget endpoints — minimal demo backend for the embeddable chat
 * widget. Replace the canned responses below with a real DB lookup +
 * LLM stream when wiring to production.
 *
 *   POST /v2/widget/view          → tenant config keyed by widgetId
 *   POST /v2/widget/create-thread → fresh thread id
 *   POST /v2/ask                  → SSE stream of token chunks
 *
 * The widget's SSE consumer (fetch-event-stream) reads raw `data:`
 * lines and decodes %20 → space, %0a → newline. Encode tokens here
 * the same way.
 */
export const v2WidgetEndpoints = async (app: any) => {
  app.group("/v2", (app: any) => {
    // ──────────────────────────────────────────────────────────────────
    // POST /v2/widget/view
    // ──────────────────────────────────────────────────────────────────
    app.post(
      "/widget/view",
      ({ body }: { body: { widgetId?: string } }) => {
        const widgetId = body?.widgetId ?? "";
        return {
          success: true,
          thread_id: `thread_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          remain_limit: 999,
          widget: {
            name: "AI 도우미",
            theme: "noir",
            animation_theme: null,
            welcome_message: "안녕하세요! 무엇이든 편하게 물어봐 주세요.",
            description: "온라인 · 보통 몇 초 안에 답해요",
            questions: [
              "어떤 기능을 쓸 수 있나요?",
              "지금 인기 있는 추천을 알려주세요",
              "방금 답변, 좀 더 자세히 설명해주세요",
              "다른 예시도 보여주세요",
            ],
            widget_message_title: null,
            widget_message_content: null,
            widget_margin_bottom: 24,
            widget_margin_right: 24,
            widget_auto_open: false,
            payment_type: "",
            font_family: null,
            icon: null,
            accept_contact: false,
            avatar_src: null,
            widget_id: widgetId,
          },
        };
      },
      {
        body: t.Object({ widgetId: t.Optional(t.String()) }),
        detail: { tags: ["API"], description: "Get widget config" },
      },
    );

    // ──────────────────────────────────────────────────────────────────
    // POST /v2/widget/create-thread
    // ──────────────────────────────────────────────────────────────────
    app.post(
      "/widget/create-thread",
      () => {
        const threadId = `thread_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        return { success: true, threadId, thread_id: threadId };
      },
      {
        body: t.Optional(t.Object({ widgetId: t.Optional(t.String()) })),
        detail: { tags: ["API"], description: "Allocate a new thread id" },
      },
    );

    // ──────────────────────────────────────────────────────────────────
    // POST /v2/ask  — SSE
    // ──────────────────────────────────────────────────────────────────
    app.post(
      "/ask",
      ({ body, set }: any) => {
        const message: string = body?.message ?? "";
        const reply = pickReply(message);
        const tokens = chunkText(reply);

        set.headers["Content-Type"] = "text/event-stream";
        set.headers["Cache-Control"] = "no-cache, no-transform";
        set.headers["Connection"] = "keep-alive";

        const stream = new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder();
            for (const tk of tokens) {
              const safe = tk.replace(/ /g, "%20").replace(/\n/g, "%0a");
              controller.enqueue(enc.encode(`data: ${safe}\n\n`));
              await sleep(40);
            }
            controller.enqueue(enc.encode(`data: [DONE]\n\n`));
            controller.close();
          },
        });
        return new Response(stream);
      },
      {
        body: t.Object({
          widgetId: t.Optional(t.String()),
          threadId: t.Optional(t.String()),
          message: t.String(),
          browserInfo: t.Optional(t.Any()),
          search: t.Optional(t.Any()),
        }),
        detail: { tags: ["API"], description: "Stream a chat reply (SSE)" },
      },
    );

    return app;
  });
};

/* ─── helpers ──────────────────────────────────────────────────────── */

function pickReply(message: string): string {
  if (/안녕|hi|hello/i.test(message))
    return "안녕하세요! 무엇을 도와드릴까요?";
  if (/기능|뭐 해|뭐할/.test(message))
    return "텍스트로 자유롭게 질문하시면 답변해 드려요. 지금은 데모 응답만 가능합니다.";
  if (/추천/.test(message))
    return "어떤 분야의 추천을 원하시나요? 좀 더 구체적으로 알려주시면 더 잘 도와드릴 수 있어요.";
  return `"${message.slice(0, 40)}" 에 대해 답변드릴게요. (지금은 데모 백엔드라 정해진 응답만 가능합니다. 실 운영 시 LLM이 연결되어 자유 대화가 가능합니다.)`;
}

function chunkText(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const len = 2 + Math.floor(Math.random() * 3);
    out.push(text.slice(i, i + len));
    i += len;
  }
  return out;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
