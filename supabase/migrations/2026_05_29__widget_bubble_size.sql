-- ════════════════════════════════════════════════════════════════════
--  Per-widget launcher bubble size
--
--  Stores a CSS size string like "48px" or "72px". NULL means "use the
--  built-in default" (which is 48px in the widget bundle). Operators can
--  set it per widget so a giant 2K icon doesn't blow up the launcher
--  and a tiny 16x16 doesn't shrink it.
-- ════════════════════════════════════════════════════════════════════

alter table public.widget
  add column if not exists chat_bubble_size text;
