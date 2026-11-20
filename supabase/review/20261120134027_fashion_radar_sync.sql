-- Review only. Keep outside supabase/migrations until the receiver and rollout are approved.
begin;
set local lock_timeout = '5s';

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

alter table public.videos add column fashion_radar_managed boolean not null default false;

-- The Worker assumes only this role. Review leaves it without a login or password.
create role kadr_radar_ingest nologin noinherit nobypassrls;
alter role kadr_radar_ingest set statement_timeout = '5s';
alter role kadr_radar_ingest set lock_timeout = '3s';
grant usage on schema private to kadr_radar_ingest;

create function private.claim_fashion_radar_request(p_id uuid, p_digest text)
returns table (status integer, platforms public.video_platform[])
language plpgsql security definer set search_path = ''
as $$
declare
  device private.fashion_radar_devices%rowtype;
  profile public.profiles%rowtype;
  requested_at timestamptz := clock_timestamp();
begin
  select * into device from private.fashion_radar_devices where id = p_id for update;
  if not found or device.secret_sha256 is distinct from p_digest
    or device.revoked_at is not null or device.expires_at <= requested_at then
    return query select 401, null::public.video_platform[];
    return;
  end if;
  select * into profile from public.profiles where id = device.profile_id for share;
  if not found or not profile.active or profile.role not in ('admin', 'member') then
    return query select 403, null::public.video_platform[];
    return;
  end if;
  if device.rate_window_at + interval '1 minute' <= requested_at then
    update private.fashion_radar_devices set rate_window_at = requested_at, rate_count = 1 where id = p_id;
  elsif device.rate_count < 10 then
    update private.fashion_radar_devices set rate_count = rate_count + 1 where id = p_id;
  else
    return query select 429, null::public.video_platform[];
    return;
  end if;
  return query select 200, device.allowed_platforms;
end;
$$;

create function private.save_fashion_radar_batch(p_id uuid, p_digest text, p_videos jsonb)
returns table (status integer, sent integer, duplicates integer)
language plpgsql security definer set search_path = ''
as $$
declare
  permitted public.video_platform[];
  batch_size integer;
  written integer;
begin
  select device.allowed_platforms into permitted
  from private.fashion_radar_devices device join public.profiles profile on profile.id = device.profile_id
  where device.id = p_id and device.secret_sha256 = p_digest and device.revoked_at is null
    and device.expires_at > clock_timestamp() and profile.active and profile.role in ('admin', 'member')
  for share of device, profile;
  if not found then
    return query select 403, 0, 0;
    return;
  end if;

  if jsonb_typeof(p_videos) is distinct from 'array' then
    raise exception 'Invalid Fashion Radar batch';
  end if;
  batch_size := jsonb_array_length(p_videos);
  if batch_size not between 1 and 1000 or exists (
    select 1 from jsonb_to_recordset(p_videos) as row(platform public.video_platform, fetched_at timestamptz)
    where row.platform is null or not (row.platform = any(permitted))
      or row.fetched_at > clock_timestamp() + interval '5 minutes'
  ) then
    return query select 403, 0, 0;
    return;
  end if;

  with changed as (
    insert into public.fashion_radar_snapshots as snapshot (
      platform, external_id, source, fetched_at, url, original_title, original_description,
      author, published_at, views, likes, comments, hashtags
    )
    select platform, external_id, source, fetched_at, url, original_title, original_description,
      author, published_at, views, likes, comments, hashtags
    from jsonb_to_recordset(p_videos) as row(
      platform public.video_platform, external_id text, source text, fetched_at timestamptz, url text,
      original_title text, original_description text, author text, published_at timestamptz,
      views bigint, likes bigint, comments bigint, hashtags text[]
    )
    order by platform, external_id, source
    on conflict (platform, external_id, source) do update set
      fetched_at = excluded.fetched_at, url = excluded.url, original_title = excluded.original_title,
      original_description = excluded.original_description, author = excluded.author, published_at = excluded.published_at,
      views = excluded.views, likes = excluded.likes, comments = excluded.comments, hashtags = excluded.hashtags
    where excluded.fetched_at > snapshot.fetched_at
    returning *
  ), projected as (
    insert into public.videos as saved (
      platform, external_id, url, author, title, description, hashtags, published_at,
      views, likes, cover, is_mock, fashion_radar_managed
    )
    select platform, external_id, url,
      case when platform = 'tiktok' then substr(split_part(url, '/', 4), 2)
        when author ~ '^[A-Za-z0-9_.]{1,30}$' then author else '' end,
      coalesce(nullif(left(trim(original_title), 120), ''),
        case when platform = 'tiktok' then 'Видео TikTok' else 'Публикация Instagram' end),
      coalesce(left(original_description, 2200), ''),
      array(select left(tag, 30) from unnest(changed.hashtags) with ordinality tags(tag, position)
        where tag is not null order by position limit 30),
      case when published_at >= timestamptz '0001-01-01 00:00:00+00'
        and published_at < timestamptz '10000-01-01 00:00:00+00' then published_at else null end,
      views, likes, '', false, true
    from changed order by platform, external_id
    on conflict (platform, external_id) do update set
      views = excluded.views, likes = excluded.likes, hashtags = excluded.hashtags, published_at = excluded.published_at
    where saved.fashion_radar_managed and not saved.is_mock
    returning id
  )
  select count(*)::integer into written from changed;
  return query select 200, written, batch_size - written;
end;
$$;

revoke all on function private.claim_fashion_radar_request(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.save_fashion_radar_batch(uuid, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function private.claim_fashion_radar_request(uuid, text) to kadr_radar_ingest;
grant execute on function private.save_fashion_radar_batch(uuid, text, jsonb) to kadr_radar_ingest;

commit;
