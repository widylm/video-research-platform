import assert from "node:assert/strict";
import { test } from "node:test";
import { supabaseConfig } from "../../lib/supabase-config.ts";

function legacyKey(role) {
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url");
  const payload = Buffer.from(JSON.stringify({ role })).toString("base64url");
  return `${header}.${payload}.fixture`;
}

test("demo mode and the public Supabase key types are accepted, privileged keys are rejected", () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  assert.equal(supabaseConfig(), null);

  const url = "https://example.supabase.co";
  process.env.SUPABASE_URL = url;
  assert.throws(supabaseConfig, /Set both SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY/);

  for (const key of ["sb_publishable_fixture", legacyKey("anon")]) {
    process.env.SUPABASE_PUBLISHABLE_KEY = key;
    assert.deepEqual(supabaseConfig(), { url, key });
  }

  for (const key of ["sb_secret_fixture", legacyKey("service_role"), "not-a-key", "x.e30.x"]) {
    process.env.SUPABASE_PUBLISHABLE_KEY = key;
    assert.throws(supabaseConfig, { message: "Use a Supabase publishable or legacy anon key." });
  }
});
