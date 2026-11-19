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

import { supabaseUntyped } from "./supabase/client";
import { isValidWidgetIconUrl, isValidWidgetBubbleSize } from "./url-guard";

export { isValidWidgetIconUrl, isValidWidgetBubbleSize };

export interface WidgetRow {
  id: string;
  name: string;
  theme: string;
  description: string;
  welcome_message: string;
  system_prompt: string | null;
  suggested_questions: string[];
  /**
   * Public URL of a custom launcher icon (the floating bubble).
   * NULL = use the built-in chat-glyph default.
   */
  icon_url: string | null;
  /**
   * CSS size for the launcher bubble (e.g. "48px", "64px"). NULL = use
   * the widget bundle's built-in default. Independent of the icon's
   * intrinsic dimensions.
   */
  chat_bubble_size: string | null;
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
  /** Pass null/'' to clear back to the default glyph. */
  icon_url?: string | null;
  /** Pass null/'' to clear back to the bundle default (48px). */
  chat_bubble_size?: string | null;
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
    icon_url: row.icon_url ?? null,
    chat_bubble_size: row.chat_bubble_size ?? null,
    is_deleted: !!row.is_deleted,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

interface CacheEntry {
  row: WidgetRow | null;
  expiresAt: number;
}

export const MAX_CACHE_ENTRIES = 500;
export const CACHE_TTL_MS = 60_000;
export const MAX_WIDGET_ID_CHARS = 100;
export const MAX_WIDGET_NAME_CHARS = 200;
export const MAX_WIDGET_THEME_CHARS = 64;
export const MAX_WIDGET_DESC_CHARS = 1000;
export const MAX_WIDGET_WELCOME_CHARS = 2000;
export const MAX_WIDGET_SYSTEM_PROMPT_CHARS = 20000;
export const MAX_SUGGESTED_QUESTIONS = 20;
export const MAX_SUGGESTED_QUESTION_CHARS = 300;

/**
 * Bounded LRU cache with TTL expiration.
 * Evicts expired entries first, then evicts oldest entries (LRU) when capacity is reached.
 */
export class BoundedLRUCache<K, V extends { expiresAt: number }> {
  private readonly max: number;
  private readonly map = new Map<K, V>();

  constructor(max: number) {
    this.max = max;
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh LRU position (delete and re-insert at tail)
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.max) {
      // Evict expired entries first
      const now = Date.now();
      for (const [k, v] of this.map.entries()) {
        if (v.expiresAt <= now) {
          this.map.delete(k);
        }
      }
      // If still at or over capacity, evict oldest entry (LRU)
      while (this.map.size >= this.max) {
        const oldestKey = this.map.keys().next().value;
        if (oldestKey === undefined) break;
        this.map.delete(oldestKey);
      }
    }
    this.map.set(key, value);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

const widgetCache = new BoundedLRUCache<string, CacheEntry>(MAX_CACHE_ENTRIES);

export function invalidateWidgetCache(id?: string) {
  if (id) {
    widgetCache.delete(id);
  } else {
    widgetCache.clear();
  }
}

/** Read one widget row, ignoring soft-deleted entries. Cached with 60s TTL. */
export async function getWidget(id: string): Promise<WidgetRow | null> {
  if (!id || id.length > MAX_WIDGET_ID_CHARS) return null;
  const now = Date.now();
  const cached = widgetCache.get(id);
  if (cached && cached.expiresAt > now) {
    return cached.row;
  }

  try {
    const { data, error } = await supabaseUntyped
      .from(TABLE)
      .select("*")
      .eq("id", id)
      .eq("is_deleted", false)
      .maybeSingle();
    if (error) {
      console.error("[widget-store] getWidget failed:", error.message);
      return null;
    }
    const result = data ? normalizeRow(data) : null;
    widgetCache.set(id, { row: result, expiresAt: now + CACHE_TTL_MS });
    return result;
  } catch (err: any) {
    console.warn("[widget-store] getWidget skipped:", err?.message || err);
    return null;
  }
}

/** List all live widgets, newest activity first. */
export async function listWidgetsRegistered(): Promise<WidgetRow[]> {
  try {
    const { data, error } = await supabaseUntyped
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
  } catch (err: any) {
    console.warn(
      "[widget-store] listWidgetsRegistered skipped:",
      err?.message || err,
    );
    return [];
  }
}

/**
 * Insert or update a widget row. The id is required; everything else is
 * patched on top of whatever's already there (PATCH semantics).
 */
export async function upsertWidget(
  input: WidgetUpsertInput,
): Promise<{ row: WidgetRow | null; error?: string }> {
  const id = (input.id ?? "").trim();
  if (!id) return { row: null, error: "id required" };
  if (id.length > MAX_WIDGET_ID_CHARS || /[\x00-\x1f\x7f]/.test(id)) {
    return {
      row: null,
      error:
        id.length > MAX_WIDGET_ID_CHARS
          ? `id exceeds maximum length of ${MAX_WIDGET_ID_CHARS} characters`
          : "invalid id (control characters prohibited)",
    };
  }

  const patch: Record<string, unknown> = { id, is_deleted: false };
  if (input.name !== undefined) {
    if (input.name.length > MAX_WIDGET_NAME_CHARS || input.name.includes("\x00")) {
      return {
        row: null,
        error: input.name.includes("\x00")
          ? "invalid name (null bytes prohibited)"
          : `name exceeds maximum length of ${MAX_WIDGET_NAME_CHARS} characters`,
      };
    }
    patch.name = input.name;
  }
  if (input.theme !== undefined) {
    if (
      input.theme.length > MAX_WIDGET_THEME_CHARS ||
      /[\x00-\x1f\x7f]/.test(input.theme)
    ) {
      return {
        row: null,
        error: `invalid theme (must be <= ${MAX_WIDGET_THEME_CHARS} characters without control chars)`,
      };
    }
    patch.theme = input.theme;
  }
  if (input.description !== undefined) {
    if (
      input.description.length > MAX_WIDGET_DESC_CHARS ||
      input.description.includes("\x00")
    ) {
      return {
        row: null,
        error: input.description.includes("\x00")
          ? "invalid description (null bytes prohibited)"
          : `description exceeds maximum length of ${MAX_WIDGET_DESC_CHARS} characters`,
      };
    }
    patch.description = input.description;
  }
  if (input.welcome_message !== undefined) {
    if (
      input.welcome_message.length > MAX_WIDGET_WELCOME_CHARS ||
      input.welcome_message.includes("\x00")
    ) {
      return {
        row: null,
        error: input.welcome_message.includes("\x00")
          ? "invalid welcome_message (null bytes prohibited)"
          : `welcome_message exceeds maximum length of ${MAX_WIDGET_WELCOME_CHARS} characters`,
      };
    }
    patch.welcome_message = input.welcome_message;
  }
  if (input.system_prompt !== undefined) {
    if (
      typeof input.system_prompt === "string" &&
      (input.system_prompt.length > MAX_WIDGET_SYSTEM_PROMPT_CHARS ||
        input.system_prompt.includes("\x00"))
    ) {
      return {
        row: null,
        error: input.system_prompt.includes("\x00")
          ? "invalid system_prompt (null bytes prohibited)"
          : `system_prompt exceeds maximum length of ${MAX_WIDGET_SYSTEM_PROMPT_CHARS} characters`,
      };
    }
    patch.system_prompt = input.system_prompt;
  }
  if (input.suggested_questions !== undefined) {
    if (input.suggested_questions.length > MAX_SUGGESTED_QUESTIONS) {
      return {
        row: null,
        error: `suggested_questions exceeds maximum of ${MAX_SUGGESTED_QUESTIONS} items`,
      };
    }
    if (
      input.suggested_questions.some(
        (q) =>
          typeof q !== "string" ||
          q.length > MAX_SUGGESTED_QUESTION_CHARS ||
          q.includes("\x00"),
      )
    ) {
      return {
        row: null,
        error: `suggested_questions item exceeds maximum length of ${MAX_SUGGESTED_QUESTION_CHARS} characters or contains null bytes`,
      };
    }
    patch.suggested_questions = input.suggested_questions;
  }
  if (input.icon_url !== undefined) {
    // empty string is treated as "clear" so the playground form can
    // simply send `""` to revert to the default glyph.
    const v = input.icon_url?.trim();
    if (v) {
      if (!isValidWidgetIconUrl(v)) {
        return {
          row: null,
          error: "invalid icon_url (must be http(s):// or relative / path)",
        };
      }
      patch.icon_url = v;
    } else {
      patch.icon_url = null;
    }
  }
  if (input.chat_bubble_size !== undefined) {
    const v = input.chat_bubble_size?.trim();
    if (v) {
      if (!isValidWidgetBubbleSize(v)) {
        return {
          row: null,
          error:
            "invalid chat_bubble_size (must be a safe CSS size like '48px' or '3.5rem')",
        };
      }
      patch.chat_bubble_size = v;
    } else {
      patch.chat_bubble_size = null;
    }
  }

  try {
    const { data, error } = await supabaseUntyped
      .from(TABLE)
      .upsert(patch, { onConflict: "id" })
      .select("*")
      .single();
    if (error) {
      console.error("[widget-store] upsertWidget failed:", error.message);
      return { row: null, error: error.message };
    }
    invalidateWidgetCache(id);
    return { row: normalizeRow(data) };
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.warn("[widget-store] upsertWidget skipped:", msg);
    return { row: null, error: msg };
  }
}

/** Soft-delete (sets is_deleted = true). Hard delete is intentionally not exposed. */
export async function deleteWidget(id: string): Promise<boolean> {
  const trimmed = (id ?? "").trim();
  if (!trimmed || trimmed.length > MAX_WIDGET_ID_CHARS) return false;
  try {
    const { error } = await supabaseUntyped
      .from(TABLE)
      .update({ is_deleted: true })
      .eq("id", trimmed);
    if (error) {
      console.error("[widget-store] deleteWidget failed:", error.message);
      return false;
    }
    invalidateWidgetCache(trimmed);
    return true;
  } catch (err: any) {
    console.warn("[widget-store] deleteWidget skipped:", err?.message || err);
    return false;
  }
}
