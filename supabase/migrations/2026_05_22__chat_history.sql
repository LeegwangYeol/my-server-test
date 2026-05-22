-- ════════════════════════════════════════════════════════════════════
--  Chat persistence for the embeddable widget
--  Two tables, anonymous-friendly. Identified by chat_thread.id (UUID).
-- ════════════════════════════════════════════════════════════════════

-- One row per conversation (= one widget user, until they clear localStorage).
create table if not exists public.chat_thread (
  id          uuid          primary key default gen_random_uuid(),
  widget_id   text          not null,
  is_deleted  boolean       not null default false,
  created_at  timestamptz   not null default now(),
  updated_at  timestamptz   not null default now()
);

create index if not exists chat_thread_widget_idx
  on public.chat_thread (widget_id, updated_at desc);

-- Append-only message log. role ∈ {system, user, assistant}.
create table if not exists public.chat_message (
  id          bigserial     primary key,
  thread_id   uuid          not null references public.chat_thread(id) on delete cascade,
  role        text          not null check (role in ('system','user','assistant')),
  content     text          not null,
  created_at  timestamptz   not null default now()
);

create index if not exists chat_message_thread_idx
  on public.chat_message (thread_id, created_at);

-- Touch chat_thread.updated_at on every new message so the most-recent
-- thread surfaces first when we later add a "recent conversations" view.
create or replace function public.tg_chat_thread_touch() returns trigger
language plpgsql as $$
begin
  update public.chat_thread
     set updated_at = now()
   where id = NEW.thread_id;
  return NEW;
end;
$$;

drop trigger if exists chat_message_touch_thread on public.chat_message;
create trigger chat_message_touch_thread
  after insert on public.chat_message
  for each row execute function public.tg_chat_thread_touch();
