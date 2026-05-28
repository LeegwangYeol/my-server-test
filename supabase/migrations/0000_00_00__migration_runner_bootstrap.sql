-- ════════════════════════════════════════════════════════════════════
--  Migration runner bootstrap — ONE-TIME, manual.
--
--  After this is applied, every future migration goes through the
--  /v2/admin/db/migrate endpoint with no SQL Editor copy-paste.
--
--  What it installs:
--    1. admin_exec_sql(text)  — security-definer wrapper that lets the
--       service_role execute arbitrary DDL via supabase-js RPC.
--    2. _migration_history    — tracks which .sql files have run.
-- ════════════════════════════════════════════════════════════════════

-- ─── helper: run arbitrary SQL as the function owner (postgres) ─────
create or replace function public.admin_exec_sql(sql text) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  execute sql;
end;
$$;

-- Lock it down — only service_role can call this. Anon / authenticated
-- users (i.e. anyone holding the public anon key) cannot.
revoke execute on function public.admin_exec_sql(text) from public, anon, authenticated;
grant execute on function public.admin_exec_sql(text) to service_role;

-- ─── migration history ─────────────────────────────────────────────
create table if not exists public._migration_history (
  name        text          primary key,
  applied_at  timestamptz   not null default now()
);

-- ─── back-fill: mark migrations that were already applied manually ─
-- The runner skips anything already in this table, so we record the
-- migrations that were paste-applied in the SQL Editor before this
-- automation existed.
insert into public._migration_history (name) values
  ('2026_05_22__chat_history.sql'),
  ('2026_05_23__widget_master.sql'),
  ('2026_05_28__thread_title.sql'),
  ('2026_05_29__widget_icon.sql'),
  ('2026_05_29__widget_bubble_size.sql'),
  ('0000_00_00__migration_runner_bootstrap.sql')
on conflict (name) do nothing;
