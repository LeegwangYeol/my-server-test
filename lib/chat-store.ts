/**
 * Thin Supabase wrapper for chat thread / message persistence.
 *
 * Backed by the chat_thread + chat_message tables created in
 * supabase/migrations/2026_05_22__chat_history.sql.
 *
 * All access goes through the service-role client (lib/supabase/client.ts)
 * so this module ONLY runs on the server.
 */

import { supabaseClient } from "./supabase/client";

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
  const { data, error } = await supabaseClient
    // @ts-expect-error — chat_thread table isn't in the auto-generated types
    // yet (Supabase introspection needs to be re-run). Runtime-safe.
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
 * Look up a thread. When widgetId is passed we also require it to match
 * the row's widget_id, so another widget can't read someone else's
 * conversation by guessing a UUID.
 */
export async function getThread(
  threadId: string,
  widgetId?: string,
): Promise<ChatThreadRow | null> {
  let query = supabaseClient
    // @ts-expect-error — see createThread
    .from("chat_thread")
    .select("*")
    .eq("id", threadId)
    .eq("is_deleted", false);
  if (widgetId) {
    query = query.eq("widget_id", widgetId);
  }
  const { data, error } = await query.maybeSingle();
  if (error) {
    console.error("[chat-store] getThread failed:", error.message);
    return null;
  }
  return (data as ChatThreadRow | null) ?? null;
}

/* ─── messages ─────────────────────────────────────────────────────── */

export async function listMessages(
  threadId: string,
  limit = 50,
): Promise<ChatMessageRow[]> {
  const { data, error } = await supabaseClient
    // @ts-expect-error — see createThread
    .from("chat_message")
    .select("*")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) {
    console.error("[chat-store] listMessages failed:", error.message);
    return [];
  }
  return (data as ChatMessageRow[] | null) ?? [];
}

export async function appendMessage(
  threadId: string,
  role: ChatRole,
  content: string,
): Promise<void> {
  const { error } = await supabaseClient
    // @ts-expect-error — see createThread
    .from("chat_message")
    .insert({ thread_id: threadId, role, content });
  if (error) {
    console.error("[chat-store] appendMessage failed:", error.message);
  }
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
  const { data, error } = await supabaseClient
    // @ts-expect-error — see createThread
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
  const { data: threads, error } = await supabaseClient
    // @ts-expect-error — see createThread
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
  const { data: msgs } = await supabaseClient
    // @ts-expect-error — see createThread
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
  const { error } = await supabaseClient
    // @ts-expect-error — see createThread
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

  const { error } = await supabaseClient
    // @ts-expect-error — see createThread
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
