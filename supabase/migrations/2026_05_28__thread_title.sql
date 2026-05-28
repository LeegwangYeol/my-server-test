-- ════════════════════════════════════════════════════════════════════
--  Add an optional human-readable title to chat_thread so operators
--  can label sessions in the admin panel (e.g. "iPhone 환불 문의").
--  Backwards-compatible: NULL = "no title yet, fall back to UUID prefix".
-- ════════════════════════════════════════════════════════════════════

alter table public.chat_thread
  add column if not exists title text;

-- Index for prefix search if we later add a "find session by name" feature.
create index if not exists chat_thread_title_idx
  on public.chat_thread (widget_id, title)
  where title is not null;
