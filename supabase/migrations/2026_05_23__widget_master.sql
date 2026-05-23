-- ════════════════════════════════════════════════════════════════════
--  Widget master — per-widget persona/config, opt-in CRUD
--
--  Before this, chat_thread.widget_id was an opaque free-form string
--  with no row representing the widget itself; /v2/widget/view returned
--  a single hardcoded persona for every widget.
--
--  This table is the source of truth for "what is widget X". When a
--  widget id has no row here the server falls back to the same
--  hardcoded default so existing embedded sites don't break.
-- ════════════════════════════════════════════════════════════════════

create table if not exists public.widget (
  id                  text          primary key,
  name                text          not null default 'AI 도우미',
  theme               text          not null default 'noir',
  description         text          not null default '온라인 · 보통 몇 초 안에 답해요',
  welcome_message     text          not null default '안녕하세요! 무엇이든 편하게 물어봐 주세요.',
  system_prompt       text,
  suggested_questions jsonb         not null default '[]'::jsonb,
  is_deleted          boolean       not null default false,
  created_at          timestamptz   not null default now(),
  updated_at          timestamptz   not null default now()
);

create index if not exists widget_updated_idx
  on public.widget (updated_at desc)
  where is_deleted = false;

-- Auto-bump updated_at on every update.
create or replace function public.tg_widget_touch() returns trigger
language plpgsql as $$
begin
  NEW.updated_at = now();
  return NEW;
end;
$$;

drop trigger if exists widget_touch on public.widget;
create trigger widget_touch
  before update on public.widget
  for each row execute function public.tg_widget_touch();
