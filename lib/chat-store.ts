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

export interface ThreadSummary {
  id: string;
  widget_id: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  last_user_message: string | null;
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
  const { data: threads, error } = await supabaseClient
    // @ts-expect-error — see createThread
    .from("chat_thread")
    .select("id, widget_id, created_at, updated_at")
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
    return {
      id: r.id,
      widget_id: r.widget_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
      message_count: entry?.count ?? 0,
      last_user_message: entry?.lastUser ?? null,
    };
  });
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
