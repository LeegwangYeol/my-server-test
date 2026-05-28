-- ════════════════════════════════════════════════════════════════════
--  Per-widget launcher icon
--
--  Adds `icon_url` to the widget master row and provisions a public
--  Storage bucket for the uploads. Backwards-compatible: NULL means
--  "use the built-in default chat-bubble glyph".
-- ════════════════════════════════════════════════════════════════════

alter table public.widget
  add column if not exists icon_url text;

-- ─── Storage bucket ─────────────────────────────────────────────────
-- Public-read so the widget bundle on any third-party page can <img>
-- the icon without auth headers. Writes are gated by the policy below
-- (service-role only, which is what our admin endpoints use).
insert into storage.buckets (id, name, public)
  values ('widget-icons', 'widget-icons', true)
  on conflict (id) do update set public = excluded.public;

-- Anyone can read (the icons are public CDN assets by design).
drop policy if exists "widget-icons public read" on storage.objects;
create policy "widget-icons public read"
  on storage.objects for select
  using (bucket_id = 'widget-icons');

-- Only the service role writes. The anon key can NOT upload — uploads
-- always go through POST /v2/admin/widgets/upload-icon which uses the
-- service-role client, so we don't accept browser uploads directly.
drop policy if exists "widget-icons service-role write" on storage.objects;
create policy "widget-icons service-role write"
  on storage.objects for insert
  with check (
    bucket_id = 'widget-icons' and auth.role() = 'service_role'
  );
