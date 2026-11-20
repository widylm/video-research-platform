-- Review only. Keep outside supabase/migrations until the receiver and rollout are approved.
begin;

create table public.fashion_radar_snapshots (
  platform public.video_platform not null,
  external_id text not null,
  source text not null,
  fetched_at timestamptz not null check (isfinite(fetched_at)),
  url text not null,
  original_title text check (char_length(original_title) <= 300),
  original_description text check (char_length(original_description) <= 5000),
  author text check (char_length(author) <= 128),
  published_at timestamptz check (isfinite(published_at)),
  views bigint check (views between 0 and 9007199254740991),
  likes bigint check (likes between 0 and 9007199254740991),
  comments bigint check (comments between 0 and 9007199254740991),
  hashtags text[] check (cardinality(hashtags) <= 100),
  primary key (platform, external_id, source),
  check (
    (platform = 'tiktok' and source = 'fashion-radar:tiktok' and external_id ~ '^[0-9]{8,25}$'
      and url ~ '^https://www[.]tiktok[.]com/@[A-Za-z0-9_.]{1,64}/video/[0-9]{8,25}$'
      and split_part(url, '/', 6) = external_id)
    or (platform = 'instagram' and source = 'fashion-radar:instagram' and external_id ~ '^[A-Za-z0-9_-]{1,64}$'
      and url = 'https://www.instagram.com/reel/' || external_id || '/')
  )
);

create table private.fashion_radar_devices (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  secret_sha256 text not null check (secret_sha256 ~ '^[a-f0-9]{64}$'),
  allowed_platforms public.video_platform[] not null check (
    cardinality(allowed_platforms) between 1 and 2 and array_position(allowed_platforms, null) is null
  ),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null check (isfinite(expires_at) and expires_at > created_at),
  revoked_at timestamptz,
  rate_window_at timestamptz not null default now(),
  rate_count smallint not null default 0 check (rate_count between 0 and 10)
);
create index fashion_radar_devices_profile_idx on private.fashion_radar_devices (profile_id);

alter table public.fashion_radar_snapshots enable row level security;
alter table private.fashion_radar_devices enable row level security;

revoke all on public.fashion_radar_snapshots from public, anon, authenticated, service_role;
revoke all on private.fashion_radar_devices from public, anon, authenticated, service_role;
grant select on public.fashion_radar_snapshots to authenticated;

create policy "Active team reads Fashion Radar snapshots"
  on public.fashion_radar_snapshots for select to authenticated
  using ((select private.current_team_role()) is not null);

-- A later change can grant a dedicated receiver role only the required operations.
-- Upsert on the primary key; add WHERE excluded.fetched_at > fashion_radar_snapshots.fetched_at.
commit;
