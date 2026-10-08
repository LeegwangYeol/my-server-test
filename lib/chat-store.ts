/**
 * Thin Supabase wrapper for chat thread / message persistence.
 *
 * Backed by the chat_thread + chat_message tables created in
 * supabase/migrations/2026_05_22__chat_history.sql.
 *
 * All access goes through the service-role client (lib/supabase/client.ts)
 * so this module ONLY runs on the server.
 */

import { supabaseUntyped } from "./supabase/client";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessageRow {
  id: number;
  thread_id: string;
  role: ChatRole;
  content: string;
  created_at: string;
}

export interface ChatThreadRow {
  id: string;
  widget_id: string;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
  /** Optional operator-set label. Falls back to UUID prefix in the UI. */
  title: string | null;
  /**
   * Optional thread-level system prompt. When set, overrides the widget's
   * default system_prompt for this session only.
   */
  system_prompt: string | null;
  /**
   * Optional reference knowledge prepended as a 2nd system message at
   * /v2/ask time. Used for per-session RAG-style grounding.
   */
  context_text: string | null;
}

/* ─── threads ──────────────────────────────────────────────────────── */

export async function createThread(widgetId: string): Promise<string | null> {
  const { data, error } = await supabaseUntyped
    .from("chat_thread")
    .insert({ widget_id: widgetId })
    .select("id")
    .single();
  if (error) {
    console.error("[chat-store] createThread failed:", error.message);
    return null;
  }
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * Look up a thread strictly scoped to widgetId.
 * widgetId is strictly required to enforce tenant ownership and guarantee
 * no fail-open query drops the tenant ownership filter.
 * Returns null if parameters are invalid or thread does not match.
 */
export async function getThread(
  threadId: string,
  widgetId: string,
): Promise<ChatThreadRow | null> {
  const wid = (widgetId ?? "").trim();
  const tid = (threadId ?? "").trim();
  if (!wid || !tid) return null;

  const { data, error } = await supabaseUntyped
    .from("chat_thread")
    .select("*")
    .eq("id", tid)
    .eq("widget_id", wid)
    .eq("is_deleted", false)
    .maybeSingle();
  if (error) {
    console.error("[chat-store] getThread failed:", error.message);
    return null;
  }
  return (data as ChatThreadRow | null) ?? null;
}

/**
 * Soft-delete a thread (sets is_deleted = true).
 * widgetId is strictly required to enforce tenant ownership and guarantee
 * no fail-open delete drops the tenant ownership filter.
 * Returns false if parameters are invalid or operation fails.
 */
export async function deleteThread(
  threadId: string,
  widgetId: string,
): Promise<boolean> {
  const wid = (widgetId ?? "").trim();
  const tid = (threadId ?? "").trim();
  if (!wid || !tid) return false;

  const { error } = await supabaseUntyped
    .from("chat_thread")
    .update({ is_deleted: true })
    .eq("id", tid)
    .eq("widget_id", wid);
  if (error) {
    console.error("[chat-store] deleteThread failed:", error.message);
    return false;
  }
  return true;
}

/**
 * Compensating rollback for a failed thread creation / initial message persistence saga.
 * Soft-deletes the thread so callers can clean up orphan threads when initial message persistence fails.
 */
export async function rollbackThread(threadId: string): Promise<boolean> {
  if (!threadId) return false;
  const { error } = await supabaseUntyped
    .from("chat_thread")
    .update({ is_deleted: true })
    .eq("id", threadId);
  if (error) {
    console.error("[chat-store] rollbackThread failed:", error.message);
    return false;
  }
  return true;
}

import {
  executeWithFallback,
  dbFallbackQueue,
  is429OrQuotaError,
  getQueuedMessagesForThread,
  registerDefaultDbHandler,
  type FallbackJob,
} from "./queue/fallback-queue";

/* ─── messages ─────────────────────────────────────────────────────── */

export async function listMessages(
  threadId: string,
  limit = 50,
): Promise<ChatMessageRow[]> {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
  let rows: ChatMessageRow[] = [];
  try {
    const { data, error } = await supabaseUntyped
      .from("chat_message")
      .select("*")
      .eq("thread_id", threadId)
      .order("created_at", { ascending: true })
      .limit(safeLimit);

    if (data) {
      rows = data as ChatMessageRow[];
    }
    if (error) {
      console.error("[chat-store] listMessages failed:", error.message);
    }
  } catch (err: any) {
    console.warn(
      "[chat-store] listMessages database query failed or skipped:",
      err?.message || err,
    );
  }

  // Merge any pending unpersisted messages in dbFallbackQueue for this thread
  const queuedRows = getQueuedMessagesForThread(threadId);
  if (queuedRows.length > 0) {
    rows = [...rows, ...(queuedRows as ChatMessageRow[])];
    rows.sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    if (rows.length > safeLimit) {
      rows = rows.slice(-safeLimit);
    }
  }

  return rows;
}

export async function appendMessage(
  threadId: string,
  role: ChatRole,
  content: string,
  options?: {
    allowQueue?: boolean;
    maxRetries?: number;
    idempotencyKey?: string;
  },
): Promise<boolean> {
  if (!threadId) return false;

  const allowQueue = options?.allowQueue !== false;
  const maxRetries = options?.maxRetries ?? 3;
  const idempotencyKey =
    options?.idempotencyKey ??
    `${threadId}:${role}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`;

  try {
    const execRes = await executeWithFallback(
      async () => {
        const { error } = await supabaseUntyped
          .from("chat_message")
          .insert({ thread_id: threadId, role, content });
        if (error) {
          throw error;
        }
        return true;
      },
      {
        queue: allowQueue ? dbFallbackQueue : undefined,
        fallbackPayload: {
          threadId,
          role,
          content,
          createdAt: new Date().toISOString(),
        },
        type: "db_chat_message",
        idempotencyKey,
        maxRetries,
        baseDelayMs: 200,
        maxDelayMs: 5000,
        operationName: "appendMessage",
      },
    );

    if (execRes.queued) {
      console.warn(
        `[chat-store] appendMessage queued due to DB 429 quota (thread: ${threadId})`,
      );
      return true;
    }

    return execRes.success;
  } catch (err: any) {
    console.error("[chat-store] appendMessage failed:", err?.message || err);
    return false;
  }
}

const defaultDbInsert = async (payload: {
  threadId: string;
  role: ChatRole;
  content: string;
  createdAt?: string;
}): Promise<boolean> => {
  try {
    const insertData: Record<string, any> = {
      thread_id: payload.threadId,
      role: payload.role,
      content: payload.content,
    };
    if (payload.createdAt) {
      insertData.created_at = payload.createdAt;
    }
    const { error } = await supabaseUntyped
      .from("chat_message")
      .insert(insertData);

    if (error) {
      if (is429OrQuotaError(error)) {
        throw error; // throw so processPending/markFailed can extract Retry-After and record real error
      }
      console.error(
        "[chat-store] processDbQueue non-429 error:",
        error.message,
      );
      return true; // discard non-retriable error to prevent queue clog
    }
    return true;
  } catch (err: any) {
    if (is429OrQuotaError(err)) {
      throw err;
    }
    console.error(
      "[chat-store] processDbQueue error:",
      err?.message || err,
    );
    return true;
  }
};

registerDefaultDbHandler(defaultDbInsert);

/**
 * Replays and processes pending DB writes stored in the db fallback queue.
 */
export async function processDbQueue(
  insertFn?: (payload: {
    threadId: string;
    role: ChatRole;
    content: string;
  }) => Promise<boolean>,
): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
}> {
  return dbFallbackQueue.processPending(
    async (
      job: FallbackJob<{ threadId: string; role: ChatRole; content: string }>,
    ) => {
      const payload = job.payload;
      if (insertFn) {
        return await insertFn(payload);
      }
      return await defaultDbInsert(payload);
    },
  );
}

/* ─── admin / sessions panel ───────────────────────────────────────── */

export interface WidgetSummary {
  widget_id: string;
  thread_count: number;
  latest_updated_at: string;
}

/**
 * Distinct widget_ids that have at least one thread, newest activity first.
 *
 * supabase-js doesn't support GROUP BY directly without a SQL view or RPC,
 * so we pull recent thread rows (capped) and aggregate in JS. Good enough
 * for an admin panel; switch to a Postgres view if you ever hit thousands
 * of widgets.
 */
export async function listWidgets(limit = 1000): Promise<WidgetSummary[]> {
  const { data, error } = await supabaseUntyped
    .from("chat_thread")
    .select("widget_id, updated_at")
    .eq("is_deleted", false)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[chat-store] listWidgets failed:", error.message);
    return [];
  }
  const rows = (data as { widget_id: string; updated_at: string }[]) ?? [];

  const byWidget = new Map<string, WidgetSummary>();
  for (const r of rows) {
    const key = r.widget_id ?? "";
    const entry =
      byWidget.get(key) ??
      ({
        widget_id: key,
        thread_count: 0,
        latest_updated_at: r.updated_at,
      } as WidgetSummary);
    entry.thread_count += 1;
    if (r.updated_at > entry.latest_updated_at) {
      entry.latest_updated_at = r.updated_at;
    }
    byWidget.set(key, entry);
  }
  return Array.from(byWidget.values()).sort((a, b) =>
    b.latest_updated_at.localeCompare(a.latest_updated_at),
  );
}

export interface ThreadSummary {
  id: string;
  widget_id: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  last_user_message: string | null;
  /** Operator-set label, NULL = "untitled". */
  title: string | null;
  /** Thread-level system prompt override (NULL = inherit widget's). */
  system_prompt: string | null;
  /** Reference knowledge for this session, prepended to the LLM prompt. */
  context_text: string | null;
}

/**
 * Threads for a given widget, newest-updated first. Adds a derived
 * message_count + a peek at the latest user turn for previews in a
 * sessions panel.
 */
export async function listThreads(
  widgetId: string,
  limit = 100,
): Promise<ThreadSummary[]> {
  // NOTE: select("*") so this keeps working both before and after the
  // `title` column migration lands. Once title is everywhere we can
  // tighten this back to an explicit column list.
  const { data: threads, error } = await supabaseUntyped
    .from("chat_thread")
    .select("*")
    .eq("widget_id", widgetId)
    .eq("is_deleted", false)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[chat-store] listThreads failed:", error.message);
    return [];
  }
  const rows = (threads as ChatThreadRow[]) ?? [];
  if (rows.length === 0) return [];

  // Fetch counts + last user message per thread in a single round trip.
  const ids = rows.map((r) => r.id);
  const { data: msgs } = await supabaseUntyped
    .from("chat_message")
    .select("thread_id, role, content, created_at")
    .in("thread_id", ids)
    .order("created_at", { ascending: false });

  const byThread = new Map<
    string,
    { count: number; lastUser: string | null }
  >();
  for (const m of (msgs as ChatMessageRow[]) ?? []) {
    const entry = byThread.get(m.thread_id) ?? { count: 0, lastUser: null };
    entry.count += 1;
    if (m.role === "user" && entry.lastUser === null) {
      entry.lastUser = m.content;
    }
    byThread.set(m.thread_id, entry);
  }

  return rows.map((r) => {
    const entry = byThread.get(r.id);
    // post-migration columns — coerce undefined → null for pre-migration rows
    const extra = r as unknown as {
      title?: string | null;
      system_prompt?: string | null;
      context_text?: string | null;
    };
    return {
      id: r.id,
      widget_id: r.widget_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
      message_count: entry?.count ?? 0,
      last_user_message: entry?.lastUser ?? null,
      title: extra.title ?? null,
      system_prompt: extra.system_prompt ?? null,
      context_text: extra.context_text ?? null,
    };
  });
}

/**
 * Set or clear the operator-visible title for a session. Pass title=null
 * (or empty string) to revert to "untitled". widgetId guards against
 * cross-tenant renames if a UUID happens to leak.
 */
export async function renameThread(
  threadId: string,
  widgetId: string,
  title: string | null,
): Promise<boolean> {
  const normalized =
    title && title.trim().length > 0 ? title.trim().slice(0, 200) : null;
  const { error } = await supabaseUntyped
    .from("chat_thread")
    .update({ title: normalized })
    .eq("id", threadId)
    .eq("widget_id", widgetId)
    .eq("is_deleted", false);
  if (error) {
    console.error("[chat-store] renameThread failed:", error.message);
    return false;
  }
  return true;
}

/**
 * Patch the prompt-tuning fields for one thread. Only the fields that
 * are passed (i.e. `!== undefined`) are touched, so the playground can
 * save just the system_prompt without nuking the context_text and vice
 * versa. Empty strings → null (= "inherit / no extra context").
 */
export async function updateThreadPrompt(
  threadId: string,
  widgetId: string,
  patch: {
    system_prompt?: string | null;
    context_text?: string | null;
  },
): Promise<boolean> {
  const update: Record<string, unknown> = {};
  if (patch.system_prompt !== undefined) {
    const v = patch.system_prompt?.trim() ?? "";
    update.system_prompt = v.length > 0 ? v : null;
  }
  if (patch.context_text !== undefined) {
    const v = patch.context_text?.trim() ?? "";
    // Hard cap so a copy-pasted novel doesn't blow up the LLM context window.
    update.context_text = v.length > 0 ? v.slice(0, 20000) : null;
  }
  if (Object.keys(update).length === 0) return true;

  const { error } = await supabaseUntyped
    .from("chat_thread")
    .update(update)
    .eq("id", threadId)
    .eq("widget_id", widgetId)
    .eq("is_deleted", false);
  if (error) {
    console.error("[chat-store] updateThreadPrompt failed:", error.message);
    return false;
  }
  return true;
}

/* ─── widget-facing message shape ──────────────────────────────────── */

/**
 * Shape returned to the widget — keeps the wire format small and
 * decoupled from DB columns. The widget consumes
 *   { role, content }[]
 * to rebuild its state on mount.
 */
export interface WidgetMessage {
  role: ChatRole;
  content: string;
}

export function toWidgetMessage(row: ChatMessageRow): WidgetMessage {
  return { role: row.role, content: row.content };
}
