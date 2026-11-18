create type public.team_role as enum ('admin', 'member', 'viewer');
create type public.video_platform as enum ('tiktok', 'instagram');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) between 1 and 80),
  role public.team_role not null default 'viewer',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.videos (
  id uuid primary key default gen_random_uuid(),
  platform public.video_platform not null,
  external_id text not null,
  url text,
  author text not null,
  title text not null,
  description text not null default '',
  hashtags text[] not null default '{}',
  published_at timestamptz not null,
  views bigint not null default 0 check (views between 0 and 9007199254740991),
  likes bigint not null default 0 check (likes between 0 and 9007199254740991),
  cover text not null,
  is_mock boolean not null default false,
  created_at timestamptz not null default now(),
  unique (platform, external_id),
  check (not is_mock or url is null)
);

create table public.search_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  query jsonb not null check (jsonb_typeof(query) = 'object' and pg_column_size(query) <= 4096),
  provider text not null default 'mock' check (provider = 'mock'),
  result_count integer not null check (result_count between 0 and 100),
  created_at timestamptz not null default now()
);
create index search_jobs_user_created_idx on public.search_jobs (user_id, created_at desc);

create table public.favorites (
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  video_id uuid not null references public.videos (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, video_id)
);

create table public.collections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 80),
  shared boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.collection_videos (
  collection_id uuid not null references public.collections (id) on delete cascade,
  video_id uuid not null references public.videos (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (collection_id, video_id)
);

create index favorites_video_idx on public.favorites (video_id);
create index collections_owner_idx on public.collections (owner_id);
create index collection_videos_video_idx on public.collection_videos (video_id);

alter table public.profiles enable row level security;
alter table public.videos enable row level security;
alter table public.search_jobs enable row level security;
alter table public.favorites enable row level security;
alter table public.collections enable row level security;
alter table public.collection_videos enable row level security;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create function private.current_team_role()
returns public.team_role
language sql stable security definer
set search_path = ''
as $$
  select role from public.profiles where id = (select auth.uid()) and active;
$$;

revoke execute on function private.current_team_role() from public;
grant execute on function private.current_team_role() to authenticated;

revoke all on table public.profiles, public.videos, public.search_jobs, public.favorites,
  public.collections, public.collection_videos from anon, authenticated;
grant select on public.profiles, public.videos to authenticated;
grant select, insert on public.search_jobs to authenticated;
grant select, insert, delete on public.favorites, public.collections, public.collection_videos to authenticated;

create policy "Active users read their profile" on public.profiles
for select to authenticated using (id = (select auth.uid()) and active);

create policy "Team reads video metadata" on public.videos
for select to authenticated using ((select private.current_team_role()) is not null);

create policy "Team reads own searches" on public.search_jobs
for select to authenticated using (
  user_id = (select auth.uid()) and (select private.current_team_role()) is not null
);

create policy "Team records own searches" on public.search_jobs
for insert to authenticated with check (
  user_id = (select auth.uid()) and (select private.current_team_role()) is not null
);

create policy "Team manages own favorites" on public.favorites
for all to authenticated
using (user_id = (select auth.uid()) and (select private.current_team_role()) is not null)
with check (user_id = (select auth.uid()) and (select private.current_team_role()) is not null);

create policy "Team reads own and shared collections" on public.collections
for select to authenticated using (
  (shared or owner_id = (select auth.uid())) and (select private.current_team_role()) is not null
);

create policy "Editors create collections" on public.collections
for insert to authenticated with check (
  owner_id = (select auth.uid()) and (select private.current_team_role()) in ('admin', 'member')
);

create policy "Owners or admins delete collections" on public.collections
for delete to authenticated using (
  (owner_id = (select auth.uid()) and (select private.current_team_role()) in ('admin', 'member'))
  or (shared and (select private.current_team_role()) = 'admin')
);

-- The parent collection's SELECT policy determines which rows are visible here.
create policy "Team reads items of visible collections" on public.collection_videos
for select to authenticated using (
  exists (select 1 from public.collections where id = collection_id)
);

create policy "Editors add items to visible collections" on public.collection_videos
for insert to authenticated with check (
  (select private.current_team_role()) in ('admin', 'member')
  and exists (select 1 from public.collections where id = collection_id)
);

create policy "Editors remove items from visible collections" on public.collection_videos
for delete to authenticated using (
  (select private.current_team_role()) in ('admin', 'member')
  and exists (select 1 from public.collections where id = collection_id)
);
