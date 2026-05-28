import { t } from "elysia";
import { createLLMProvider, type ChatMessage } from "../../../lib/llm";
import {
  appendMessage,
  createThread,
  getThread,
  listMessages,
  listThreads,
  listWidgets as listWidgetsByActivity,
  renameThread,
  toWidgetMessage,
} from "../../../lib/chat-store";
import {
  deleteWidget,
  getWidget,
  listWidgetsRegistered,
  upsertWidget,
  type WidgetRow,
} from "../../../lib/widget-store";

/**
 * v2 widget endpoints — backend for the embeddable chat widget.
 *
 *   POST /v2/widget/view          → tenant config + restored messages
 *   POST /v2/widget/create-thread → fresh thread id (UUID, persisted)
 *   POST /v2/ask                  → SSE stream + persist user + assistant
 *
 * Conversation memory:
 *   - The widget keeps a thread_id in localStorage.
 *   - On every mount it POSTs to /v2/widget/view with that thread_id, and we
 *     reply with the full message history so the panel rehydrates.
 *   - /v2/ask: persists the user message, fetches prior history, hands it to
 *     the LLM as conversation context, streams the reply, then persists the
 *     assistant message at the end.
 */
export const v2WidgetEndpoints = async (app: any) => {
  app.group("/v2", (app: any) => {
    // ──────────────────────────────────────────────────────────────────
    // POST /v2/widget/view
    // ──────────────────────────────────────────────────────────────────
    app.post(
      "/widget/view",
      async ({ body }: { body: { widgetId?: string; threadId?: string } }) => {
        const widgetId = body?.widgetId ?? "";

        // Resolve thread: use the one the widget sent if it exists and isn't
        // deleted, otherwise mint a fresh one.
        let threadId = body?.threadId ?? "";
        let messages: { role: string; content: string }[] = [];

        if (threadId) {
          const existing = await getThread(threadId, widgetId);
          if (existing) {
            const rows = await listMessages(threadId);
            messages = rows.map(toWidgetMessage);
          } else {
            // The id the widget held is gone (table wiped, expired, etc.) —
            // start over so we don't keep handing out a dangling reference.
            threadId = "";
          }
        }
        if (!threadId) {
          threadId = (await createThread(widgetId)) ?? "";
        }

        // Pull persona from the widget master table if it exists; otherwise
        // fall back to the hardcoded default so unregistered embeds keep
        // working.
        const master = widgetId ? await getWidget(widgetId) : null;
        const persona = renderPersona(master, widgetId);

        return {
          success: true,
          thread_id: threadId,
          remain_limit: 999,
          messages, // ← widget will hydrate state.messages from this
          widget: persona,
        };
      },
      {
        body: t.Object({
          widgetId: t.Optional(t.String()),
          threadId: t.Optional(t.String()),
        }),
        detail: {
          tags: ["API"],
          description: "Widget config + restored thread messages",
        },
      },
    );

    // ──────────────────────────────────────────────────────────────────
    // POST /v2/widget/create-thread
    // ──────────────────────────────────────────────────────────────────
    app.post(
      "/widget/create-thread",
      async ({ body }: { body: { widgetId?: string } }) => {
        const widgetId = body?.widgetId ?? "";
        const threadId = (await createThread(widgetId)) ?? "";
        return { success: true, threadId, thread_id: threadId };
      },
      {
        body: t.Optional(t.Object({ widgetId: t.Optional(t.String()) })),
        detail: {
          tags: ["API"],
          description: "Allocate a new persisted thread id",
        },
      },
    );

    // ──────────────────────────────────────────────────────────────────
    // POST /v2/ask  — LLM stream with persistent history
    // ──────────────────────────────────────────────────────────────────
    app.post(
      "/ask",
      async ({ body, set }: any) => {
        const widgetId: string = body?.widgetId ?? "";
        const userMessage: string = body?.message ?? "";
        let threadId: string = body?.threadId ?? "";

        // Make sure we have a thread on file before persisting anything.
        if (threadId) {
          const existing = await getThread(threadId, widgetId);
          if (!existing) threadId = "";
        }
        if (!threadId) {
          threadId = (await createThread(widgetId)) ?? "";
        }

        // Persist the incoming user message and capture history up to this
        // point. We log the user message first so it shows up in subsequent
        // history fetches even if the LLM call below crashes.
        if (threadId && userMessage) {
          await appendMessage(threadId, "user", userMessage);
        }
        const history = threadId ? await listMessages(threadId) : [];

        set.headers["Content-Type"] = "text/event-stream";
        set.headers["Cache-Control"] = "no-cache, no-transform";
        set.headers["Connection"] = "keep-alive";

        const stream = new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder();
            const sendChunk = (text: string) => {
              const safe = text.replace(/ /g, "%20").replace(/\n/g, "%0a");
              controller.enqueue(enc.encode(`data: ${safe}\n\n`));
            };

            let provider;
            try {
              provider = createLLMProvider();
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              sendChunk(`[LLM 설정 오류] ${msg}`);
              controller.enqueue(enc.encode(`data: [DONE]\n\n`));
              controller.close();
              return;
            }

            let assistantBuffer = "";
            try {
              if (provider) {
                // Widget-specific system prompt wins. Fall through to the
                // env var, then to a tight default.
                const widgetMaster = widgetId
                  ? await getWidget(widgetId)
                  : null;
                const systemContent =
                  widgetMaster?.system_prompt?.trim() ||
                  process.env.LLM_SYSTEM_PROMPT ||
                  [
                    "You are a helpful assistant embedded in a website.",
                    "Reply in the user's language.",
                    "Keep every answer to 1–2 short sentences. Never use bullet lists, headings, or long explanations unless the user explicitly asks for detail.",
                    "If you don't know, say so in one sentence — do not guess.",
                  ].join(" ");

                // Build context from persisted history (already includes the
                // user message we just wrote above).
                const messages: ChatMessage[] = [
                  { role: "system", content: systemContent },
                  ...history.map((m) => ({
                    role: m.role,
                    content: m.content,
                  })),
                ];

                const maxTokens = Number.parseInt(
                  process.env.LLM_MAX_TOKENS ?? "512",
                  10,
                );
                for await (const token of provider.stream({
                  messages,
                  maxTokens: Number.isFinite(maxTokens) ? maxTokens : 512,
                })) {
                  assistantBuffer += token;
                  sendChunk(token);
                }
              } else {
                const fallback = pickReply(userMessage);
                for (const tk of chunkText(fallback)) {
                  assistantBuffer += tk;
                  sendChunk(tk);
                  await sleep(40);
                }
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              sendChunk(`\n[LLM error] ${msg}`);
            } finally {
              // Persist the assistant turn no matter how the stream ended,
              // as long as we actually produced text.
              if (threadId && assistantBuffer.trim()) {
                appendMessage(threadId, "assistant", assistantBuffer).catch(
                  (e) => console.error("[v2/ask] persist assistant failed:", e),
                );
              }
              controller.enqueue(enc.encode(`data: [DONE]\n\n`));
              controller.close();
            }
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
        detail: {
          tags: ["API"],
          description: "Stream a chat reply (SSE) + persist both turns",
        },
      },
    );

    // ──────────────────────────────────────────────────────────────────
    // POST /v2/admin/threads — list sessions for a widget
    // POST /v2/admin/messages — list messages for one thread
    //
    // Read-only sessions panel for the dev playground. UUID-based
    // identification only; do not surface in production hosts until a
    // proper admin auth layer is added.
    // ──────────────────────────────────────────────────────────────────
    /**
     * Returns both registered widgets (widget master rows) and unregistered
     * widget_ids that exist only as activity in chat_thread, so the admin
     * panel can show everything in one list with a `registered` flag.
     */
    app.post(
      "/admin/widgets",
      async () => {
        const [registered, byActivity] = await Promise.all([
          listWidgetsRegistered(),
          listWidgetsByActivity(),
        ]);

        const registeredMap = new Map<string, WidgetRow>();
        for (const w of registered) registeredMap.set(w.id, w);

        const activityMap = new Map<string, (typeof byActivity)[number]>();
        for (const w of byActivity) activityMap.set(w.widget_id, w);

        const ids = new Set<string>([
          ...registeredMap.keys(),
          ...activityMap.keys(),
        ]);

        const widgets = Array.from(ids).map((id) => {
          const reg = registeredMap.get(id);
          const act = activityMap.get(id);
          return {
            widget_id: id,
            registered: !!reg,
            name: reg?.name ?? null,
            theme: reg?.theme ?? null,
            description: reg?.description ?? null,
            welcome_message: reg?.welcome_message ?? null,
            system_prompt: reg?.system_prompt ?? null,
            suggested_questions: reg?.suggested_questions ?? null,
            thread_count: act?.thread_count ?? 0,
            latest_updated_at:
              act?.latest_updated_at ??
              reg?.updated_at ??
              new Date(0).toISOString(),
          };
        });

        // Newest activity (or creation) first.
        widgets.sort((a, b) =>
          b.latest_updated_at.localeCompare(a.latest_updated_at),
        );

        return { success: true, widgets };
      },
      {
        detail: {
          tags: ["API"],
          description: "Widget master rows + chat_thread activity",
        },
      },
    );

    app.post(
      "/admin/widgets/upsert",
      async ({ body }: { body: any }) => {
        const id = (body?.id ?? "").trim();
        if (!id) return { success: false, error: "id required" };
        const result = await upsertWidget({
          id,
          name: body?.name,
          theme: body?.theme,
          description: body?.description,
          welcome_message: body?.welcome_message,
          system_prompt: body?.system_prompt,
          suggested_questions: Array.isArray(body?.suggested_questions)
            ? body.suggested_questions
            : undefined,
        });
        return {
          success: !!result.row,
          widget: result.row,
          error: result.error,
        };
      },
      {
        body: t.Object({
          id: t.String(),
          name: t.Optional(t.String()),
          theme: t.Optional(t.String()),
          description: t.Optional(t.String()),
          welcome_message: t.Optional(t.String()),
          system_prompt: t.Optional(t.Union([t.String(), t.Null()])),
          suggested_questions: t.Optional(t.Array(t.String())),
        }),
        detail: { tags: ["API"], description: "Create or update a widget" },
      },
    );

    app.post(
      "/admin/widgets/delete",
      async ({ body }: { body: { id?: string } }) => {
        const id = (body?.id ?? "").trim();
        if (!id) return { success: false };
        const ok = await deleteWidget(id);
        return { success: ok };
      },
      {
        body: t.Object({ id: t.String() }),
        detail: { tags: ["API"], description: "Soft-delete a widget" },
      },
    );

    app.post(
      "/admin/threads",
      async ({ body }: { body: { widgetId?: string } }) => {
        const widgetId = body?.widgetId?.trim() ?? "";
        if (!widgetId) return { success: false, threads: [] };
        const threads = await listThreads(widgetId);
        return { success: true, threads };
      },
      {
        body: t.Object({ widgetId: t.Optional(t.String()) }),
        detail: { tags: ["API"], description: "Sessions for a widget" },
      },
    );

    /**
     * POST /v2/admin/threads/rename
     *
     * Set or clear the human-readable title shown in the admin sessions
     * panel. Pass an empty string (or omit `title`) to revert to "untitled".
     * widgetId is required so a leaked thread UUID can't be relabeled
     * by another tenant.
     */
    app.post(
      "/admin/threads/rename",
      async ({
        body,
      }: {
        body: { widgetId?: string; threadId?: string; title?: string | null };
      }) => {
        const widgetId = body?.widgetId?.trim() ?? "";
        const threadId = body?.threadId?.trim() ?? "";
        if (!widgetId || !threadId) {
          return { success: false, reason: "widgetId+threadId required" };
        }
        const ok = await renameThread(
          threadId,
          widgetId,
          (body?.title ?? null) as string | null,
        );
        return { success: ok };
      },
      {
        body: t.Object({
          widgetId: t.String(),
          threadId: t.String(),
          title: t.Optional(t.Union([t.String(), t.Null()])),
        }),
        detail: { tags: ["API"], description: "Rename a session" },
      },
    );

    app.post(
      "/admin/messages",
      async ({ body }: { body: { widgetId?: string; threadId?: string } }) => {
        const widgetId = body?.widgetId?.trim() ?? "";
        const threadId = body?.threadId?.trim() ?? "";
        if (!widgetId || !threadId) {
          return { success: false, messages: [] };
        }
        const thread = await getThread(threadId, widgetId);
        if (!thread) return { success: false, messages: [] };
        const rows = await listMessages(threadId, 500);
        return {
          success: true,
          thread: {
            id: thread.id,
            widget_id: thread.widget_id,
            created_at: thread.created_at,
            updated_at: thread.updated_at,
          },
          messages: rows.map((r) => ({
            role: r.role,
            content: r.content,
            created_at: r.created_at,
          })),
        };
      },
      {
        body: t.Object({
          widgetId: t.Optional(t.String()),
          threadId: t.Optional(t.String()),
        }),
        detail: { tags: ["API"], description: "Messages for a thread" },
      },
    );

    return app;
  });
};

/**
 * Build the `widget` block of the /v2/widget/view payload.
 *
 * When a master row exists we use those fields; missing fields and the
 * unregistered case both fall through to a single hardcoded default so
 * old embedded sites keep working.
 */
function renderPersona(master: WidgetRow | null, widgetId: string) {
  const DEFAULT_NAME = "AI 도우미";
  const DEFAULT_THEME = "noir";
  const DEFAULT_DESCRIPTION = "온라인 · 보통 몇 초 안에 답해요";
  const DEFAULT_WELCOME = "안녕하세요! 무엇이든 편하게 물어봐 주세요.";
  const DEFAULT_QUESTIONS = [
    "어떤 기능을 쓸 수 있나요?",
    "지금 인기 있는 추천을 알려주세요",
    "방금 답변, 좀 더 자세히 설명해주세요",
    "다른 예시도 보여주세요",
  ];

  return {
    name: master?.name?.trim() || DEFAULT_NAME,
    theme: master?.theme || DEFAULT_THEME,
    animation_theme: null,
    welcome_message: master?.welcome_message?.trim() || DEFAULT_WELCOME,
    description: master?.description?.trim() || DEFAULT_DESCRIPTION,
    questions:
      master && master.suggested_questions.length > 0
        ? master.suggested_questions
        : DEFAULT_QUESTIONS,
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
  };
}

/* ─── canned-reply fallback (used when LLM_API_KEY is missing) ───────── */

function pickReply(message: string): string {
  if (/안녕|hi|hello/i.test(message)) return "안녕하세요! 무엇을 도와드릴까요?";
  if (/기능|뭐 해|뭐할/.test(message))
    return "텍스트로 자유롭게 질문하시면 답변해 드려요. (지금은 LLM이 연결되지 않은 데모 응답이에요.)";
  if (/추천/.test(message))
    return "어떤 분야의 추천을 원하시나요? 좀 더 구체적으로 알려주시면 더 잘 도와드릴 수 있어요.";
  return `"${message.slice(0, 40)}" 에 대해 답변드릴게요. (LLM_API_KEY 미설정 — .env에 키를 추가하면 진짜 LLM 응답으로 전환됩니다.)`;
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
