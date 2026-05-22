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

export async function getThread(
  threadId: string,
): Promise<ChatThreadRow | null> {
  const { data, error } = await supabaseClient
    // @ts-expect-error — see createThread
    .from("chat_thread")
    .select("*")
    .eq("id", threadId)
    .eq("is_deleted", false)
    .maybeSingle();
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
