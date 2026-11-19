begin;

set local lock_timeout = '5s';

-- Existing demo rows and their IDs stay intact. Unset metrics on new rows are NULL.
alter table public.videos
  alter column published_at drop not null,
  alter column views drop not null,
  alter column views drop default,
  alter column likes drop not null,
  alter column likes drop default,
  add constraint videos_public_metadata_check check (
    is_mock or (
      url is not null and cover = '' and char_length(description) <= 2200
      and char_length(title) between 1 and 120 and cardinality(hashtags) <= 30
      and pg_column_size(hashtags) <= 4096
      and (published_at is null or (published_at >= timestamptz '0001-01-01 00:00:00+00'
        and published_at < timestamptz '10000-01-01 00:00:00+00'))
      and (
        (platform = 'tiktok' and author ~ '^[A-Za-z0-9_.]{1,64}$'
          and external_id ~ '^[0-9]{8,25}$'
          and url = 'https://www.tiktok.com/@' || author || '/video/' || external_id)
        or (platform = 'instagram' and author = '' and external_id ~ '^[A-Za-z0-9_-]{1,64}$'
          and url in (
            'https://www.instagram.com/p/' || external_id || '/',
            'https://www.instagram.com/reel/' || external_id || '/',
            'https://www.instagram.com/tv/' || external_id || '/'
          ))
      )
    )
  );

grant insert (platform, external_id, url, author, title, description, hashtags, published_at, views, likes, cover)
  on public.videos to authenticated;

create policy "Editors save public video metadata" on public.videos
for insert to authenticated with check (
  not is_mock and (select private.current_team_role()) in ('admin', 'member')
);

-- Both writes share a transaction and run with the caller's existing RLS.
-- The unique key resolves retries and concurrent imports without replacing metadata.
create function public.save_public_video(
  p_platform public.video_platform, p_external_id text, p_url text, p_author text,
  p_title text, p_description text, p_hashtags text[], p_published_at date,
  p_views bigint, p_likes bigint, p_collection_id uuid
)
returns table (video public.videos, created boolean)
language plpgsql volatile security invoker
set search_path = ''
as $$
declare
  saved public.videos;
  was_created boolean;
begin
  -- Check even when the video already exists and there is no collection to link.
  if coalesce((select private.current_team_role()) not in ('admin', 'member'), true) then
    raise insufficient_privilege;
  end if;

  insert into public.videos
    (platform, external_id, url, author, title, description, hashtags, published_at, views, likes, cover)
  values (
    p_platform, p_external_id, p_url, p_author, p_title, p_description, p_hashtags,
    p_published_at::timestamp at time zone 'UTC', p_views, p_likes, ''
  )
  on conflict (platform, external_id) do nothing
  returning * into saved;

  was_created := found;
  if not was_created then
    select existing.* into strict saved
    from public.videos as existing
    where existing.platform = p_platform and existing.external_id = p_external_id;
  end if;

  if p_collection_id is not null then
    insert into public.collection_videos (collection_id, video_id)
    values (p_collection_id, saved.id)
    on conflict (collection_id, video_id) do nothing;
  end if;

  return query select saved, was_created;
end;
$$;

revoke all on function public.save_public_video(
  public.video_platform, text, text, text, text, text, text[], date, bigint, bigint, uuid
) from public, anon;
grant execute on function public.save_public_video(
  public.video_platform, text, text, text, text, text, text[], date, bigint, bigint, uuid
) to authenticated;

create function public.search_saved_videos(
  p_platform public.video_platform, p_keywords text[], p_hashtags text[],
  p_from date, p_to date, p_min_views bigint, p_min_likes bigint, p_sort text, p_limit integer
)
returns setof public.videos
language sql stable security invoker
set search_path = ''
as $$
  select v.*
  from public.videos as v
  where (p_platform is null or v.platform = p_platform)
    and v.hashtags @> coalesce(p_hashtags, '{}'::text[])
    and not exists (
      select 1 from pg_catalog.unnest(p_keywords) as keyword(value)
      where pg_catalog.strpos(
        lower(normalize(concat_ws(' ', v.title, v.description, v.author, array_to_string(v.hashtags, ' ')))),
        keyword.value
      ) = 0
    )
    and (p_from is null or v.published_at >= (p_from::timestamp at time zone 'UTC'))
    and (p_to is null or v.published_at < ((p_to + 1)::timestamp at time zone 'UTC'))
    and (p_min_views is null or v.views >= p_min_views)
    and (p_min_likes is null or v.likes >= p_min_likes)
  order by
    case when p_sort = 'views' then v.views end desc nulls last,
    case when p_sort = 'likes' then v.likes end desc nulls last,
    v.published_at desc nulls last, v.id asc
  limit greatest(1, least(coalesce(p_limit, 24), 100));
$$;

revoke all on function public.search_saved_videos(
  public.video_platform, text[], text[], date, date, bigint, bigint, text, integer
) from public, anon;
grant execute on function public.search_saved_videos(
  public.video_platform, text[], text[], date, date, bigint, bigint, text, integer
) to authenticated;

alter table public.search_jobs drop constraint search_jobs_provider_check,
  add constraint search_jobs_provider_check check (provider in ('mock', 'catalog'));

notify pgrst, 'reload schema';

commit;
