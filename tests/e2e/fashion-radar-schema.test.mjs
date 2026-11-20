import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("review SQL isolates credentials, gates snapshot reads and preserves newer data during upsert", async (t) => {
  const image = (await read("./compose.yml")).match(/image: (postgres@\S+)/)[1];
  const name = `kadr-radar-schema-${randomUUID()}`;
  const docker = (args, input) => execFileSync("docker", args, { input, encoding: "utf8", timeout: 90_000, stdio: ["pipe", "pipe", "pipe"] });
  docker(["run", "--detach", "--rm", "--network", "none", "--name", name, "-e", "POSTGRES_HOST_AUTH_METHOD=trust", image]);
  t.after(() => docker(["rm", "-f", name]));
  const sql = (input) => docker(["exec", "-i", name, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-qAt"], input).trim();
  for (let attempt = 0; ; attempt += 1) {
    try {
      docker(["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]);
      break;
    } catch (error) {
      if (attempt === 29) throw error;
      await delay(500);
    }
  }
  sql(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated;
  `);
  sql(await read("../../supabase/migrations/20261118000100_initial_schema.sql"));
  sql(await read("../../supabase/review/20261120134027_fashion_radar_sync.sql"));

  const member = "10000000-0000-0000-0000-000000000001";
  const inactive = "10000000-0000-0000-0000-000000000002";
  sql(`
    insert into auth.users (id) values ('${member}'), ('${inactive}');
    insert into public.profiles (id, display_name, role, active)
      values ('${member}', 'Active member', 'member', true), ('${inactive}', 'Inactive', 'member', false);
    insert into public.fashion_radar_snapshots (platform, external_id, source, fetched_at, url, views)
      values ('tiktok', '7000000000000000001', 'fashion-radar:tiktok', '2026-11-20T10:00:00Z',
        'https://www.tiktok.com/@demo.test/video/7000000000000000001', 0);
    insert into public.fashion_radar_snapshots (platform, external_id, source, fetched_at, url, views)
      values ('tiktok', '7000000000000000001', 'fashion-radar:tiktok', '2026-11-19T10:00:00Z',
        'https://www.tiktok.com/@demo.test/video/7000000000000000001', 100)
      on conflict (platform, external_id, source) do update set views = excluded.views, fetched_at = excluded.fetched_at
      where excluded.fetched_at > fashion_radar_snapshots.fetched_at;
  `);
  assert.equal(sql(`set role authenticated; set "request.jwt.claim.sub" = '${member}';
    select count(*), max(views), count(likes) from public.fashion_radar_snapshots;`), "1|0|0");
  assert.equal(sql(`set role authenticated; set "request.jwt.claim.sub" = '${inactive}';
    select count(*) from public.fashion_radar_snapshots;`), "0");
  assert.throws(() => sql("set role anon; select * from public.fashion_radar_snapshots;"), /permission denied/);
  assert.throws(() => sql("set role authenticated; select secret_sha256 from private.fashion_radar_devices;"), /permission denied/);
  assert.throws(() => sql("set role service_role; update public.fashion_radar_snapshots set views = 99;"), /permission denied/);
  assert.throws(() => sql("set role kadr_radar_ingest; select secret_sha256 from private.fashion_radar_devices;"), /permission denied/);
  assert.throws(() => sql("set role kadr_radar_ingest; update public.videos set views = 99;"), /permission denied/);
  assert.throws(() => sql("set role authenticated; select * from private.claim_fashion_radar_request(gen_random_uuid(), 'fake');"), /permission denied/);
  assert.throws(() => sql(`insert into public.fashion_radar_snapshots (platform, external_id, source, fetched_at, url)
    values ('instagram', 'Demo_Reel', 'mock:instagram', now(), 'https://www.instagram.com/reel/Demo_Reel/');`), /check constraint/);
});
