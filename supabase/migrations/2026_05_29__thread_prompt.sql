-- ════════════════════════════════════════════════════════════════════
--  Per-session prompt + reference text
--
--  Until now the system prompt for /v2/ask came from the widget master
--  row (or the env var). With this migration each thread can override:
--
--    chat_thread.system_prompt  → custom instruction for this session
--    chat_thread.context_text   → reference knowledge that gets
--                                  prepended as a second system message
--                                  (RAG-style — the model uses it as
--                                  ground truth when answering)
--
--  Both columns are nullable. Resolution order at /v2/ask time:
--    thread.system_prompt  > widget.system_prompt  > env  > default
--    thread.context_text   → only used if set (no fallback)
-- ════════════════════════════════════════════════════════════════════

alter table public.chat_thread
  add column if not exists system_prompt text;

alter table public.chat_thread
  add column if not exists context_text text;
