-- BTSC Crew Hub — database setup
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to run again.

-- ---------------------------------------------------------------
-- People: one row per login. role = 'admin' (office) or 'crew'.
-- crew_id ties a crew member to a row on the schedule board.
-- ---------------------------------------------------------------
create table if not exists public.people (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  username text not null unique,
  role text not null default 'crew' check (role in ('admin','crew')),
  crew_id text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- PINs are handed out by the office and shown on the People screen,
-- so admins can look them up. Only admins can read this table.
create table if not exists public.pins (
  id uuid primary key references public.people(id) on delete cascade,
  pin text not null
);

-- ---------------------------------------------------------------
-- Document store. Every board record (tiles, weeks, config,
-- prepsites, bins, maps, changes, ...) is one row: coll/id.
-- ---------------------------------------------------------------
create table if not exists public.docs (
  path text primary key,
  coll text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
create index if not exists docs_coll_idx on public.docs (coll);
create index if not exists docs_coll_at_idx on public.docs (coll, (data->>'at'));
alter table public.docs replica identity full;

-- ---------------------------------------------------------------
-- Helpers (security definer so policies can call them safely)
-- ---------------------------------------------------------------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.people where id = auth.uid() and role = 'admin' and active);
$$;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.people where id = auth.uid() and active);
$$;

create or replace function public.my_crew() returns text
language sql stable security definer set search_path = public as $$
  select crew_id from public.people where id = auth.uid() and active;
$$;

-- ---------------------------------------------------------------
-- Row security
-- ---------------------------------------------------------------
alter table public.people enable row level security;
alter table public.pins enable row level security;
alter table public.docs enable row level security;

drop policy if exists people_read on public.people;
create policy people_read on public.people for select to authenticated
  using (id = auth.uid() or public.is_member());
drop policy if exists people_write on public.people;
create policy people_write on public.people for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists pins_admin on public.pins;
create policy pins_admin on public.pins for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Office (admins) read everything. Crew read only what My day needs.
drop policy if exists docs_read on public.docs;
create policy docs_read on public.docs for select to authenticated
  using (public.is_admin()
      or (public.is_member() and coll in ('tiles','weeks','config','prepsites','maps')));
drop policy if exists docs_insert on public.docs;
create policy docs_insert on public.docs for insert to authenticated
  with check (public.is_admin());
drop policy if exists docs_update on public.docs;
create policy docs_update on public.docs for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists docs_delete on public.docs;
create policy docs_delete on public.docs for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------
-- First login: the very first person to set up becomes an admin.
-- After that, only admins add people (from the People screen).
-- ---------------------------------------------------------------
create or replace function public.claim_first_admin(p_name text, p_username text, p_pin text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if exists(select 1 from public.people where role = 'admin') then return false; end if;
  insert into public.people(id, name, username, role) values (auth.uid(), p_name, lower(p_username), 'admin')
    on conflict (id) do update set role = 'admin', active = true;
  insert into public.pins(id, pin) values (auth.uid(), p_pin) on conflict (id) do update set pin = excluded.pin;
  return true;
end $$;

create or replace function public.setup_needed() returns boolean
language sql stable security definer set search_path = public as $$
  select not exists(select 1 from public.people where role = 'admin');
$$;

-- ---------------------------------------------------------------
-- Crew "Done" button. A crew member can only mark jobs on their own
-- crew's row. Snow stakes / container / Snowrator jobs also check the
-- site off on the pre-season checklist, same as the office hub does.
-- ---------------------------------------------------------------
create or replace function public.crew_mark_done(p_tile text, p_done boolean, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me public.people;
  t public.docs;
  col text;
  site_key text;
  label text;
  lid uuid := gen_random_uuid();
  now_iso text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  select * into me from public.people where id = auth.uid() and active;
  if me.id is null then raise exception 'not allowed'; end if;
  select * into t from public.docs where path = 'tiles/' || p_tile;
  if t.path is null then raise exception 'job not found'; end if;
  if me.role <> 'admin' and coalesce(t.data->>'crew','') <> coalesce(me.crew_id,'') then
    raise exception 'not your crew';
  end if;

  col := case t.data->>'type' when 'stakes' then 'stakes' when 'container' then 'container' when 'snowrator' then 'snowrator' else null end;
  label := coalesce(nullif(t.data->>'site',''), 'Shop') || ' ' ||
           case t.data->>'type' when 'mow' then 'mowing' when 'cleanup' then 'fall cleanup' when 'stakes' then 'snow stakes'
             when 'container' then 'container stocking' when 'snowrator' then 'Snowrator delivery' when 'repair' then 'repair / project'
             when 'pw' then 'pressure wash' when 'shop' then 'shop' when 'help' then 'help crew' else 'job' end;

  update public.docs set
    data = data || jsonb_build_object('done', p_done, 'doneBy', me.name, 'doneAt', now_iso)
         || case when p_note is not null and length(trim(p_note)) > 0 then jsonb_build_object('crewNote', left(p_note, 500)) else '{}'::jsonb end,
    updated_at = now(), updated_by = me.id
  where path = t.path;

  if col is not null and coalesce(t.data->>'site','') <> '' then
    site_key := regexp_replace(t.data->>'site', '[^A-Za-z0-9]', '_', 'g');
    insert into public.docs(path, coll, id, data, updated_by)
      values ('prepsites/' || site_key, 'prepsites', site_key,
              jsonb_build_object(col, case when p_done then 1 else 0 end, 'updatedAt', now_iso, 'updatedBy', me.name), me.id)
    on conflict (path) do update set
      data = public.docs.data || jsonb_build_object(col, case when p_done then 1 else 0 end, 'updatedAt', now_iso, 'updatedBy', me.name),
      updated_at = now(), updated_by = me.id;
    insert into public.docs(path, coll, id, data, updated_by)
      values ('fieldlog/' || lid, 'fieldlog', lid::text,
              jsonb_build_object('site', t.data->>'site', 'item', col, 'value', case when p_done then 'done' else 'undone' end, 'by', me.name, 'at', now_iso), me.id);
  end if;

  insert into public.docs(path, coll, id, data, updated_by)
    select 'changes/' || g, 'changes', g::text,
      jsonb_build_object('at', now_iso, 'by', me.name, 'byId', me.id::text, 'week', coalesce(t.data->>'week',''),
        'kind', 'crew', 'text', case when p_done then 'Marked ' || label || ' done' else 'Marked ' || label || ' not done' end
          || case when p_note is not null and length(trim(p_note)) > 0 then ': “' || left(p_note, 160) || '”' else '' end), me.id
    from gen_random_uuid() g;

  return (select data from public.docs where path = t.path);
end $$;

grant execute on function public.is_admin(), public.is_member(), public.my_crew(), public.setup_needed() to authenticated, anon;
grant execute on function public.claim_first_admin(text, text, text), public.crew_mark_done(text, boolean, text) to authenticated;

-- ---------------------------------------------------------------
-- Live updates
-- ---------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'docs') then
    execute 'alter publication supabase_realtime add table public.docs';
  end if;
exception when undefined_object then null; end $$;

-- ---------------------------------------------------------------
-- Map images: private storage bucket. Everyone signed in can view,
-- only admins can upload or delete.
-- ---------------------------------------------------------------
insert into storage.buckets (id, name, public) values ('maps', 'maps', false)
  on conflict (id) do nothing;

drop policy if exists maps_read on storage.objects;
create policy maps_read on storage.objects for select to authenticated
  using (bucket_id = 'maps' and public.is_member());
drop policy if exists maps_write on storage.objects;
create policy maps_write on storage.objects for insert to authenticated
  with check (bucket_id = 'maps' and public.is_admin());
drop policy if exists maps_update on storage.objects;
create policy maps_update on storage.objects for update to authenticated
  using (bucket_id = 'maps' and public.is_admin());
drop policy if exists maps_delete on storage.objects;
create policy maps_delete on storage.objects for delete to authenticated
  using (bucket_id = 'maps' and public.is_admin());
