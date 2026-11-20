import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const composeFile = fileURLToPath(new URL("compose.yml", import.meta.url));
const testValue = () => randomBytes(32).toString("base64url");

function testJwt(role, secret) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role, exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

async function waitFor(url, statuses, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2_000) }).catch(() => null);
    if (response) {
      await response.body?.cancel();
      if (statuses.includes(response.status)) return;
    }
    await delay(300);
  }
  throw new Error(`Local test service was not ready at ${url}`);
}

async function listen(server) {
  const ready = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await ready;
  return server.address().port;
}

function gateway(authPort, restPort, coverRequests) {
  return createServer((incoming, outgoing) => {
    if (/^\/(?:storage\/v1\b|rest\/v1\/rpc\/saved_video_cover_versions\b)/.test(incoming.url)) {
      coverRequests.push(new URL(incoming.url, "http://localhost").pathname);
      return outgoing.writeHead(503).end();
    }
    const match = /^\/(auth|rest)\/v1(\/.*)?$/.exec(incoming.url);
    if (!match) return outgoing.writeHead(404).end();

    const upstream = request({
      hostname: "127.0.0.1",
      port: match[1] === "auth" ? authPort : restPort,
      path: match[2] || "/",
      method: incoming.method,
      headers: incoming.headers,
    }, (response) => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("error", () => outgoing.writeHead(502).end());
    incoming.pipe(upstream);
  });
}

export async function startSupabaseStack() {
  await access(join(repo, ".open-next/worker.js")).catch(() => {
    throw new Error("Run npm run cf:build before npm run test:e2e.");
  });

  const dir = await mkdtemp(join(tmpdir(), "kadr-e2e-"));
  const project = `kadr-e2e-${process.pid}-${randomBytes(4).toString("hex")}`;
  const dbPassword = testValue();
  const restPassword = testValue();
  const jwtSecret = testValue();
  const anonKey = testJwt("anon", jwtSecret);
  const adminKey = testJwt("service_role", jwtSecret);
  const password = testValue();
  const redact = (message) => [dbPassword, restPassword, jwtSecret, anonKey, adminKey, password]
    .reduce((text, value) => text.replaceAll(value, "[test credential]"), message);
  const env = {
    ...process.env,
    KADR_TEST_DB_PASSWORD: dbPassword,
    KADR_TEST_REST_PASSWORD: restPassword,
    KADR_TEST_JWT_SECRET: jwtSecret,
  };
  const compose = (args, input) => {
    const result = spawnSync("docker", ["compose", "--progress", "quiet", "-f", composeFile, "-p", project, ...args], {
      env, input, encoding: "utf8", timeout: 180_000,
    });
    if (result.status !== 0) {
      throw new Error(`Test Docker stack failed (${args[0]}): ${redact(result.error?.message ?? result.stderr)}`);
    }
    return result.stdout.trim();
  };
  const sql = (source) => compose(["exec", "-T", "db", "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1"], source);
  const port = (service, internalPort) => Number(compose(["port", service, String(internalPort)]).split(":").at(-1));
  const coverRequests = [];
  let proxy;
  let worker;
  let radarServer;
  let cloudBrowserServer;

  async function stopProcess(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }

  async function stop() {
    await stopProcess(cloudBrowserServer);
    await stopProcess(radarServer);
    await stopProcess(worker);
    if (proxy?.listening) {
      proxy.close();
      proxy.closeAllConnections();
    }
    try {
      compose(["down", "-v"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  try {
    compose(["up", "-d", "--wait", "db"]);
    sql(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      create role authenticator noinherit login password '${restPassword}';
      grant anon, authenticated to authenticator;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$
        select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
      $$;
      grant usage on schema auth to authenticated, anon;
    `);

    compose(["up", "-d", "auth", "rest"]);
    const authPort = port("auth", 9999);
    const restPort = port("rest", 3000);
    proxy = gateway(authPort, restPort, coverRequests);
    const supabaseUrl = `http://127.0.0.1:${await listen(proxy)}`;
    await Promise.all([
      waitFor(`${supabaseUrl}/auth/v1/health`, [200]),
      waitFor(`${supabaseUrl}/rest/v1/`, [200]),
    ]);

    const migrations = await Promise.all([
      readFile(join(repo, "supabase/migrations/20261118000100_initial_schema.sql"), "utf8"),
      readFile(join(repo, "supabase/migrations/20261118000200_mock_catalog.sql"), "utf8"),
    ]);
    sql(["begin;", ...migrations, "commit;"].join("\n"));
    sql(await readFile(join(repo, "supabase/migrations/20261119000100_saved_public_videos.sql"), "utf8"));
    sql(await readFile(join(repo, "supabase/migrations/20261119000200_edit_video_metadata.sql"), "utf8"));

    const profiles = {
      admin: "Администратор тестовой команды",
      member: "Участник тестовой команды",
      viewer: "Наблюдатель тестовой команды",
      outsider: null,
    };
    const users = {};
    for (const [role, name] of Object.entries(profiles)) {
      const email = `${role}@example.com`;
      const response = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, email_confirm: true }),
      });
      const { id } = await response.json();
      if (!response.ok || !/^[\da-f-]{36}$/i.test(id)) {
        throw new Error(`Could not provision the ${role} test account (HTTP ${response.status}).`);
      }
      if (name) sql(`insert into public.profiles (id, display_name, role) values ('${id}', '${name}', '${role}');`);
      users[role] = { id, email, password, name };
    }

    await copyFile(join(repo, "wrangler.jsonc"), join(dir, "wrangler.jsonc"));
    await symlink(join(repo, ".open-next"), join(dir, ".open-next"), "dir");
    await writeFile(join(dir, ".dev.vars"), `SUPABASE_URL=${supabaseUrl}\nSUPABASE_PUBLISHABLE_KEY=${anonKey}\n`,
      { mode: 0o600 });

    const probingServer = createServer();
    const workerPort = await listen(probingServer);
    await new Promise((resolve, reject) => probingServer.close((error) => error ? reject(error) : resolve()));

    const workerEnv = { ...process.env, XDG_CONFIG_HOME: join(dir, "xdg"), WRANGLER_SEND_METRICS: "false" };
    delete workerEnv.SUPABASE_URL;
    delete workerEnv.SUPABASE_PUBLISHABLE_KEY;

    worker = spawn(process.execPath, [join(repo, "node_modules/wrangler/bin/wrangler.js"), "dev", "--ip", "127.0.0.1",
      "--port", String(workerPort)], { cwd: dir, env: workerEnv, stdio: ["ignore", "pipe", "pipe"] });
    let workerLog = "";
    for (const stream of [worker.stdout, worker.stderr]) {
      stream.on("data", (data) => { workerLog = (workerLog + data).slice(-4_000); });
    }

    const appUrl = `http://127.0.0.1:${workerPort}`;
    await waitFor(`${appUrl}/login`, [200]).catch((error) => {
      throw new Error(`${error.message}\n${redact(workerLog)}`);
    });

    async function restAs(role, path, options = {}) {
      let token = anonKey;
      if (role !== "anon") {
        const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
          method: "POST",
          headers: { apikey: anonKey, "Content-Type": "application/json" },
          body: JSON.stringify({ email: users[role].email, password: users[role].password }),
        });
        ({ access_token: token } = await response.json());
        if (!response.ok || typeof token !== "string") throw new Error(`No session for test role ${role}`);
      }

      return fetch(`${supabaseUrl}/rest/v1/${path}`, {
        ...options,
        headers: { ...options.headers, apikey: anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
    }

    async function startRadarReceiver() {
      sql(await readFile(join(repo, "supabase/review/20261120134027_fashion_radar_sync.sql"), "utf8"));
      const certificate = join(dir, "radar-postgres.crt");
      const key = join(dir, "radar-postgres.key");
      const cert = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-noenc", "-days", "1",
        "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-out", certificate, "-keyout", key],
      { encoding: "utf8", timeout: 10_000 });
      if (cert.status !== 0) throw new Error("Could not generate the isolated Postgres TLS certificate.");
      compose(["cp", certificate, "db:/tmp/radar-postgres.crt"]);
      compose(["cp", key, "db:/tmp/radar-postgres.key"]);
      compose(["exec", "-T", "-u", "root", "db", "chown", "postgres:postgres", "/tmp/radar-postgres.key", "/tmp/radar-postgres.crt"]);
      compose(["exec", "-T", "-u", "root", "db", "chmod", "600", "/tmp/radar-postgres.key"]);
      sql(`
        alter system set ssl_cert_file = '/tmp/radar-postgres.crt';
        alter system set ssl_key_file = '/tmp/radar-postgres.key';
        alter system set ssl = on;
        select pg_reload_conf();
        notify pgrst, 'reload schema';
      `);
      for (let attempt = 0; !sql("show ssl;").includes("on"); attempt += 1) {
        if (attempt === 10) throw new Error("Test Postgres did not load TLS settings.");
        await delay(200);
      }
      const receiverPassword = testValue();
      sql(`alter role kadr_radar_ingest login password '${receiverPassword}';`);
      function enroll(role, platforms) {
        const id = randomUUID();
        const secret = testValue();
        const digest = createHash("sha256").update(secret).digest("hex");
        const scope = platforms.map((platform) => `'${platform}'`).join(",");
        sql(`insert into private.fashion_radar_devices (id, profile_id, secret_sha256, allowed_platforms, expires_at)
          values ('${id}', '${users[role].id}', '${digest}', array[${scope}]::public.video_platform[], now() + interval '10 minutes');`);
        return { token: `${id}.${secret}`, revoke: () => sql(`update private.fashion_radar_devices set revoked_at = now() where id = '${id}';`) };
      }

      const probe = createServer();
      const apiPort = await listen(probe);
      await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
      const radarDir = join(dir, "radar-worker");
      await mkdir(radarDir);
      await copyFile(join(repo, "wrangler.jsonc"), join(radarDir, "wrangler.jsonc"));
      await symlink(join(repo, ".open-next"), join(radarDir, ".open-next"), "dir");
      const databaseUrl = `postgresql://kadr_radar_ingest:${receiverPassword}@127.0.0.1:${port("db", 5432)}/postgres`;
      await writeFile(join(radarDir, ".dev.vars"), `SUPABASE_URL=${supabaseUrl}\nSUPABASE_PUBLISHABLE_KEY=${anonKey}
KADR_FASHION_RADAR_ENABLED=1\nKADR_FASHION_RADAR_DB_URL=${databaseUrl}\n`, { mode: 0o600 });
      radarServer = spawn(process.execPath, [join(repo, "node_modules/wrangler/bin/wrangler.js"), "dev", "--ip", "127.0.0.1",
        "--port", String(apiPort)], { cwd: radarDir, stdio: "ignore", env: { ...workerEnv, NODE_EXTRA_CA_CERTS: certificate } });
      const endpoint = `http://127.0.0.1:${apiPort}/api/integrations/fashion-radar`;
      await waitFor(endpoint, [405]);
      return { endpoint, enroll };
    }

    async function startCloudBrowser(sourceUrl) {
      const browserDir = join(dir, "cloud-browser");
      await mkdir(browserDir);
      const appConfig = join(browserDir, "wrangler.jsonc");
      const executorConfig = join(browserDir, "executor.jsonc");
      await copyFile(join(repo, "wrangler.cloud-browser.jsonc"), appConfig);
      await symlink(join(repo, ".open-next"), join(browserDir, ".open-next"), "dir");
      await copyFile(join(dir, ".dev.vars"), join(browserDir, ".dev.vars"));
      const config = JSON.parse(await readFile(join(repo, "workers/cloud-browser/wrangler.jsonc"), "utf8"));
      config.main = join(repo, "workers/cloud-browser/index.ts");
      config.vars = { KADR_BROWSER_SOURCE: "local", KADR_BROWSER_SOURCE_URL: sourceUrl };
      await writeFile(executorConfig, JSON.stringify(config));
      const probe = createServer();
      const apiPort = await listen(probe);
      await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
      cloudBrowserServer = spawn(process.execPath, [join(repo, "node_modules/wrangler/bin/wrangler.js"), "dev", "--local",
        "-c", appConfig, "-c", executorConfig, "--ip", "127.0.0.1", "--port", String(apiPort), "--inspector-port", "0"], {
        cwd: browserDir, stdio: ["ignore", "pipe", "pipe"], env: {
          ...workerEnv, CI: "1", CLOUDFLARE_CF_FETCH_ENABLED: "false", XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || join(dir, "cache"),
        },
      });
      let log = "";
      for (const stream of [cloudBrowserServer.stdout, cloudBrowserServer.stderr]) {
        stream.on("data", (data) => { log = (log + data).slice(-3_000); });
      }
      const url = `http://127.0.0.1:${apiPort}`;
      await waitFor(url + "/api/cloud-browser", [401]).catch((error) => {
        throw new Error(`${error.message}\n${redact(log)}`);
      });
      return { url, logs: () => redact(log) };
    }

    return { appUrl, users, restAs, coverRequests, stop, startRadarReceiver, startCloudBrowser };
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Could not start or clean up the isolated test stack.");
    }
    throw error;
  }
}
