import { t } from "elysia";
import { supabaseClient } from "../../../lib/supabase/client";
import { createLLMProvider, type ChatMessage } from "../../../lib/llm";
import { MIGRATIONS } from "../../generated-migrations";
import {
  appendMessage,
  createThread,
  getThread,
  listMessages,
  listThreads,
  listWidgets as listWidgetsByActivity,
  renameThread,
  toWidgetMessage,
  updateThreadPrompt,
} from "../../../lib/chat-store";
import {
  deleteWidget,
  getWidget,
  listWidgetsRegistered,
  upsertWidget,
  type WidgetRow,
} from "../../../lib/widget-store";

/** Headers bag as Elysia hands it to a POST handler. */
type AdminHeaders = Record<string, string | undefined>;

/**
 * Gate for every /admin/* endpoint. Returns an error payload to `return`
 * when the `x-admin-token` header doesn't match the server's ADMIN_TOKEN,
 * or null when the caller is authorized. The token is the single shared
 * secret held in the ADMIN_TOKEN env var (Vercel + local .env) — the admin
 * playground sends it on every call; without it these endpoints used to be
 * wide open to anyone who knew the URL.
 */
function requireAdmin(
  headers: AdminHeaders,
): { success: false; error: string } | null {
  const expected = process.env.ADMIN_TOKEN?.trim();
  if (!expected) {
    return { success: false, error: "ADMIN_TOKEN env var not set on server" };
  }
  const token = (headers?.["x-admin-token"] || "").trim();
  if (token !== expected) return { success: false, error: "unauthorized" };
  return null;
}

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
              // Percent-encode the chunk so it can't contain a raw newline
              // (SSE event boundary) or a leading space (trimmed by the
              // "data: " parser). '%' MUST be escaped first — otherwise a
              // literal '%' in the model output (e.g. "50%", "C++ 100%")
              // becomes a dangling percent that throws URIError in the
              // client's decodeURIComponent and truncates the stream.
              const safe = text
                .replace(/%/g, "%25")
                .replace(/ /g, "%20")
                .replace(/\n/g, "%0a")
                .replace(/\r/g, "%0d");
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
                // Resolution order for the system prompt:
                //   thread.system_prompt (per-session override) >
                //   widget.system_prompt                         >
                //   LLM_SYSTEM_PROMPT env                        >
                //   built-in default
                const [widgetMaster, threadRow] = await Promise.all([
                  widgetId ? getWidget(widgetId) : Promise.resolve(null),
                  threadId
                    ? getThread(threadId, widgetId)
                    : Promise.resolve(null),
                ]);
                const systemContent =
                  threadRow?.system_prompt?.trim() ||
                  widgetMaster?.system_prompt?.trim() ||
                  process.env.LLM_SYSTEM_PROMPT ||
                  [
                    "You are a helpful assistant embedded in a website.",
                    "Reply in the user's language.",
                    "Keep every answer to 1–2 short sentences. Never use bullet lists, headings, or long explanations unless the user explicitly asks for detail.",
                    "If you don't know, say so in one sentence — do not guess.",
                  ].join(" ");

                // RAG-style: if the operator pasted reference material on
                // this thread, inject it as a 2nd system message so the
                // model treats it as ground truth for this session.
                const refText = threadRow?.context_text?.trim();

                const messages: ChatMessage[] = [
                  { role: "system", content: systemContent },
                  ...(refText
                    ? [
                        {
                          role: "system" as const,
                          content:
                            "다음은 이 세션 전용 참고 자료입니다. " +
                            "사용자 질문에 답할 때 이 자료를 최우선 근거로 활용하고, " +
                            "자료에 없는 내용은 추측하지 말고 모른다고 답하세요.\n\n" +
                            "─── 참고 자료 ───\n" +
                            refText +
                            "\n─── 참고 자료 끝 ───",
                        },
                      ]
                    : []),
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
      async ({ headers }: { headers: AdminHeaders }) => {
        const deny = requireAdmin(headers);
        if (deny) return deny;
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
            icon_url: reg?.icon_url ?? null,
            chat_bubble_size: reg?.chat_bubble_size ?? null,
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
      async ({ headers, body }: { headers: AdminHeaders; body: any }) => {
        const deny = requireAdmin(headers);
        if (deny) return deny;
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
          icon_url: body?.icon_url,
          chat_bubble_size: body?.chat_bubble_size,
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
          icon_url: t.Optional(t.Union([t.String(), t.Null()])),
          chat_bubble_size: t.Optional(t.Union([t.String(), t.Null()])),
        }),
        detail: { tags: ["API"], description: "Create or update a widget" },
      },
    );

    /**
     * POST /v2/admin/db/migrate
     *
     * Applies every supabase/migrations/*.sql file that isn't already
     * recorded in public._migration_history (in lexicographic order).
     * Each file is executed atomically; on the first failure we stop and
     * return what succeeded plus the failing entry.
     *
     * Auth: pass the shared secret via the `X-Admin-Token` header
     * matching the ADMIN_TOKEN env var. If ADMIN_TOKEN is unset the
     * endpoint refuses to run (fail-closed).
     *
     * Body (all optional):
     *   { dryRun?: boolean }  — only report what would run; doesn't mutate
     */
    app.post(
      "/admin/db/migrate",
      async ({
        headers,
        body,
      }: {
        headers: Record<string, string | undefined>;
        body: { dryRun?: boolean } | undefined;
      }) => {
        const deny = requireAdmin(headers);
        if (deny) return deny;

        // Read history
        const { data: appliedRows, error: histErr } = await supabaseClient
          // @ts-expect-error — table not in generated types
          .from("_migration_history")
          .select("name");
        if (histErr) {
          return {
            success: false,
            error: `read history failed: ${histErr.message}`,
          };
        }
        const appliedSet = new Set(
          ((appliedRows as { name: string }[]) ?? []).map((r) => r.name),
        );
        const pending = MIGRATIONS.filter((m) => !appliedSet.has(m.name));

        if (body?.dryRun) {
          return {
            success: true,
            dryRun: true,
            applied: appliedRows ?? [],
            pending: pending.map((m) => m.name),
          };
        }

        const results: { name: string; ok: boolean; error?: string }[] = [];
        for (const m of pending) {
          const { error: execErr } = await supabaseClient.rpc(
            "admin_exec_sql" as never,
            { sql: m.content } as never,
          );
          if (execErr) {
            results.push({ name: m.name, ok: false, error: execErr.message });
            break;
          }
          const { error: trackErr } = await supabaseClient
            // @ts-expect-error — table not in generated types
            .from("_migration_history")
            .insert({ name: m.name });
          if (trackErr) {
            results.push({
              name: m.name,
              ok: false,
              error: `applied but history insert failed: ${trackErr.message}`,
            });
            break;
          }
          results.push({ name: m.name, ok: true });
        }

        const allOk = results.every((r) => r.ok);
        const pendingNotRun = pending.slice(results.length).map((m) => m.name);
        return {
          success: allOk,
          ran: results,
          remaining: pendingNotRun,
          totalPending: pending.length,
        };
      },
      {
        body: t.Optional(t.Object({ dryRun: t.Optional(t.Boolean()) })),
        detail: {
          tags: ["API"],
          description: "Auto-apply pending Supabase migrations",
        },
      },
    );

    /**
     * POST /v2/admin/widgets/upload-icon
     *
     * Multipart upload — accepts a single image file under `file` plus
     * the target `widgetId`. Stores the object under
     *   widget-icons/<widgetId>/<timestamp>-<random>.<ext>
     * and returns its public URL. The caller is expected to follow up
     * with /admin/widgets/upsert{ icon_url } to persist the link.
     *
     * Service-role client (SUPABASE_SERVICE_KEY) is used so the upload
     * bypasses RLS. The bucket itself is public-read.
     */
    app.post(
      "/admin/widgets/upload-icon",
      async ({
        headers,
        body,
      }: {
        headers: AdminHeaders;
        body: { widgetId: string; file: File };
      }) => {
        const deny = requireAdmin(headers);
        if (deny) return deny;
        const widgetId = (body?.widgetId ?? "").trim();
        const file = body?.file;
        if (!widgetId) return { success: false, error: "widgetId required" };
        if (!file) return { success: false, error: "file required" };
        if (!file.type?.startsWith("image/")) {
          return { success: false, error: "image/* required" };
        }
        // Hard cap to avoid abuse — anything past 2 MiB likely needs a
        // CDN-resized variant anyway.
        const MAX = 2 * 1024 * 1024;
        if (file.size > MAX) {
          return { success: false, error: `file too large (>${MAX} bytes)` };
        }

        const safeWid = widgetId.replace(/[^a-zA-Z0-9_-]/g, "_");
        const ext =
          (file.name.split(".").pop() || "png").toLowerCase().slice(0, 4) ||
          "png";
        const rand = Math.random().toString(36).slice(2, 8);
        const path = `${safeWid}/${Date.now()}-${rand}.${ext}`;

        const buf = await file.arrayBuffer();
        const { error } = await supabaseClient.storage
          .from("widget-icons")
          .upload(path, new Uint8Array(buf), {
            contentType: file.type,
            upsert: false,
          });
        if (error) {
          console.error("[upload-icon] failed:", error.message);
          return { success: false, error: error.message };
        }
        const { data } = supabaseClient.storage
          .from("widget-icons")
          .getPublicUrl(path);
        return { success: true, icon_url: data.publicUrl, path };
      },
      {
        body: t.Object({
          widgetId: t.String(),
          file: t.File({ type: "image" }),
        }),
        detail: { tags: ["API"], description: "Upload a launcher icon" },
      },
    );

    app.post(
      "/admin/widgets/delete",
      async ({
        headers,
        body,
      }: {
        headers: AdminHeaders;
        body: { id?: string };
      }) => {
        const deny = requireAdmin(headers);
        if (deny) return deny;
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
      async ({
        headers,
        body,
      }: {
        headers: AdminHeaders;
        body: { widgetId?: string };
      }) => {
        const deny = requireAdmin(headers);
        if (deny) return deny;
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
     * POST /v2/admin/threads/update
     *
     * Patch the prompt-tuning fields on a single thread. Used by the
     * playground "tune this session" form. Fields you don't pass are
     * left alone (so the title rename + this can co-exist). Pass empty
     * strings to clear back to "inherit / no extra context".
     */
    app.post(
      "/admin/threads/update",
      async ({
        headers,
        body,
      }: {
        headers: AdminHeaders;
        body: {
          widgetId?: string;
          threadId?: string;
          system_prompt?: string | null;
          context_text?: string | null;
        };
      }) => {
        const deny = requireAdmin(headers);
        if (deny) return deny;
        const widgetId = body?.widgetId?.trim() ?? "";
        const threadId = body?.threadId?.trim() ?? "";
        if (!widgetId || !threadId) {
          return { success: false, reason: "widgetId+threadId required" };
        }
        const ok = await updateThreadPrompt(threadId, widgetId, {
          system_prompt: body.system_prompt,
          context_text: body.context_text,
        });
        return { success: ok };
      },
      {
        body: t.Object({
          widgetId: t.String(),
          threadId: t.String(),
          system_prompt: t.Optional(t.Union([t.String(), t.Null()])),
          context_text: t.Optional(t.Union([t.String(), t.Null()])),
        }),
        detail: {
          tags: ["API"],
          description: "Tune a session's system_prompt + context_text",
        },
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
        headers,
        body,
      }: {
        headers: AdminHeaders;
        body: { widgetId?: string; threadId?: string; title?: string | null };
      }) => {
        const deny = requireAdmin(headers);
        if (deny) return deny;
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
      async ({
        headers,
        body,
      }: {
        headers: AdminHeaders;
        body: { widgetId?: string; threadId?: string };
      }) => {
        const deny = requireAdmin(headers);
        if (deny) return deny;
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
    // Operator-set launcher size (CSS string, e.g. "48px"). NULL lets
    // the widget bundle fall back to its own default.
    widget_bubble_size: master?.chat_bubble_size ?? null,
    widget_auto_open: false,
    payment_type: "",
    font_family: null,
    // Custom launcher icon (the floating bubble). When NULL the widget
    // bundle falls back to its built-in chat-glyph SVG.
    icon: master?.icon_url ?? null,
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
