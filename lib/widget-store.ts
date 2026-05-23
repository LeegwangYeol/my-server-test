/**
 * Widget master CRUD — the persona/config for each widgetId.
 *
 * Backed by the public.widget table created in
 * supabase/migrations/2026_05_23__widget_master.sql.
 *
 * Anything missing here is meant to fall back to the hardcoded defaults
 * baked into /v2/widget/view so existing embeds keep working even if a
 * widget hasn't been registered yet.
 */

import { supabaseClient } from "./supabase/client";

export interface WidgetRow {
  id: string;
  name: string;
  theme: string;
  description: string;
  welcome_message: string;
  system_prompt: string | null;
  suggested_questions: string[];
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
}

export interface WidgetUpsertInput {
  id: string;
  name?: string;
  theme?: string;
  description?: string;
  welcome_message?: string;
  system_prompt?: string | null;
  suggested_questions?: string[];
}

const TABLE = "widget" as const;

function normalizeRow(row: any): WidgetRow {
  return {
    id: row.id,
    name: row.name ?? "",
    theme: row.theme ?? "noir",
    description: row.description ?? "",
    welcome_message: row.welcome_message ?? "",
    system_prompt: row.system_prompt ?? null,
    suggested_questions: Array.isArray(row.suggested_questions)
      ? row.suggested_questions
      : [],
    is_deleted: !!row.is_deleted,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Read one widget row, ignoring soft-deleted entries. */
export async function getWidget(id: string): Promise<WidgetRow | null> {
  if (!id) return null;
  const { data, error } = await supabaseClient
    // @ts-expect-error — widget table not in generated types yet
    .from(TABLE)
    .select("*")
    .eq("id", id)
    .eq("is_deleted", false)
    .maybeSingle();
  if (error) {
    console.error("[widget-store] getWidget failed:", error.message);
    return null;
  }
  return data ? normalizeRow(data) : null;
}

/** List all live widgets, newest activity first. */
export async function listWidgetsRegistered(): Promise<WidgetRow[]> {
  const { data, error } = await supabaseClient
    // @ts-expect-error — widget table not in generated types yet
    .from(TABLE)
    .select("*")
    .eq("is_deleted", false)
    .order("updated_at", { ascending: false })
    .limit(500);
  if (error) {
    console.error(
      "[widget-store] listWidgetsRegistered failed:",
      error.message,
    );
    return [];
  }
  return (data ?? []).map(normalizeRow);
}

/**
 * Insert or update a widget row. The id is required; everything else is
 * patched on top of whatever's already there (PATCH semantics).
 */
export async function upsertWidget(
  input: WidgetUpsertInput,
): Promise<{ row: WidgetRow | null; error?: string }> {
  if (!input.id) return { row: null, error: "id required" };

  const patch: Record<string, unknown> = { id: input.id, is_deleted: false };
  if (input.name !== undefined) patch.name = input.name;
  if (input.theme !== undefined) patch.theme = input.theme;
  if (input.description !== undefined) patch.description = input.description;
  if (input.welcome_message !== undefined)
    patch.welcome_message = input.welcome_message;
  if (input.system_prompt !== undefined)
    patch.system_prompt = input.system_prompt;
  if (input.suggested_questions !== undefined)
    patch.suggested_questions = input.suggested_questions;

  const { data, error } = await supabaseClient
    // @ts-expect-error — widget table not in generated types yet
    .from(TABLE)
    .upsert(patch, { onConflict: "id" })
    .select("*")
    .single();
  if (error) {
    console.error("[widget-store] upsertWidget failed:", error.message);
    return { row: null, error: error.message };
  }
  return { row: normalizeRow(data) };
}

/** Soft-delete (sets is_deleted = true). Hard delete is intentionally not exposed. */
export async function deleteWidget(id: string): Promise<boolean> {
  if (!id) return false;
  const { error } = await supabaseClient
    // @ts-expect-error — widget table not in generated types yet
    .from(TABLE)
    .update({ is_deleted: true })
    .eq("id", id);
  if (error) {
    console.error("[widget-store] deleteWidget failed:", error.message);
    return false;
  }
  return true;
}
