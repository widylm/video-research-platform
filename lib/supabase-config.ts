export function supabaseConfig() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url && !key) return null;
  if (!url || !key) throw new Error("Set both SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.");
  return { url, key };
}
