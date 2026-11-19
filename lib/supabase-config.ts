function isPublicKey(key: string): boolean {
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return true;

  // Legacy project API keys carry their database role in the JWT payload.
  const jwt = /^[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/.exec(key);
  if (!jwt) return false;

  try {
    const payload: unknown = JSON.parse(atob(jwt[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload === "object" && payload !== null && "role" in payload && payload.role === "anon";
  } catch {
    return false;
  }
}

export function supabaseConfig() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url && !key) return null;
  if (!url || !key) throw new Error("Set both SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.");
  if (!isPublicKey(key)) throw new Error("Use a Supabase publishable or legacy anon key.");
  return { url, key };
}
