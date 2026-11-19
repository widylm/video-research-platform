begin;

set local lock_timeout = '5s';

-- Permit a manually supplied Instagram handle while preserving the canonical URL checks.
alter table public.videos
  drop constraint videos_public_metadata_check,
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
        or (platform = 'instagram' and (author = '' or author ~ '^[A-Za-z0-9_.]{1,30}$') and external_id ~ '^[A-Za-z0-9_-]{1,64}$'
          and url in (
            'https://www.instagram.com/p/' || external_id || '/',
            'https://www.instagram.com/reel/' || external_id || '/',
            'https://www.instagram.com/tv/' || external_id || '/'
          ))
      )
    )
  );

grant update (title, description, author) on public.videos to authenticated;

create policy "Editors update saved video details" on public.videos
for update to authenticated
using (not is_mock and (select private.current_team_role()) in ('admin', 'member'))
with check (not is_mock and (select private.current_team_role()) in ('admin', 'member'));

notify pgrst, 'reload schema';

commit;
