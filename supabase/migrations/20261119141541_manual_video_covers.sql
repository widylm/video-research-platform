begin;

set local lock_timeout = '5s';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('video-covers', 'video-covers', false, 524288, array['image/jpeg']);

-- Paths identify existing non-demo videos. Evaluate the cast only for canonical paths.
create function private.is_saved_video_cover(p_name text)
returns boolean
language sql stable security invoker set search_path = ''
as $$
  select exists (
    select 1 from public.videos v
    where v.id = case when p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]jpg$'
      then left(p_name, 36)::uuid end
      and not v.is_mock
  )
$$;

revoke all on function private.is_saved_video_cover(text) from public;
grant execute on function private.is_saved_video_cover(text) to authenticated;

create policy "Team reads saved video covers" on storage.objects
for select to authenticated using (
  bucket_id = 'video-covers' and (select private.current_team_role()) is not null
  and private.is_saved_video_cover(name)
);

create policy "Editors upload saved video covers" on storage.objects
for insert to authenticated with check (
  bucket_id = 'video-covers' and (select private.current_team_role()) in ('admin', 'member')
  and private.is_saved_video_cover(name)
);

create policy "Editors replace saved video covers" on storage.objects
for update to authenticated
using (
  bucket_id = 'video-covers' and (select private.current_team_role()) in ('admin', 'member')
  and private.is_saved_video_cover(name)
)
with check (
  bucket_id = 'video-covers' and (select private.current_team_role()) in ('admin', 'member')
  and private.is_saved_video_cover(name)
);

create policy "Editors remove saved video covers" on storage.objects
for delete to authenticated using (
  bucket_id = 'video-covers' and (select private.current_team_role()) in ('admin', 'member')
  and private.is_saved_video_cover(name)
);

-- Read the versions in one request. Both tables still enforce the caller's RLS.
create function public.saved_video_cover_versions(video_ids uuid[])
returns table (id uuid, revision text)
language sql stable security invoker set search_path = ''
as $$
  select distinct on (v.id) v.id, coalesce(o.version::text, o.updated_at::text)
  from public.videos v
  join storage.objects o on o.bucket_id = 'video-covers' and o.name = v.id::text || '.jpg'
  where v.id = any(video_ids) and not v.is_mock
  order by v.id, o.updated_at desc
$$;

revoke all on function public.saved_video_cover_versions(uuid[]) from public;
grant execute on function public.saved_video_cover_versions(uuid[]) to authenticated;

notify pgrst, 'reload schema';

commit;
