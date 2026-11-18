import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabaseConfig } from "@/lib/supabase-config";

export interface Profile {
  id: string;
  display_name: string;
  role: "admin" | "member" | "viewer";
}

export async function serverSupabase() {
  const config = supabaseConfig();
  if (!config) return null;
  const cookieStore = await cookies();

  return createServerClient(config.url, config.key, {
    cookieOptions: { httpOnly: true, secure: process.env.NODE_ENV === "production" },
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (values) => {
        try {
          values.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Middleware refreshes session cookies before Server Components render.
        }
      },
    },
  });
}

export type Supabase = NonNullable<Awaited<ReturnType<typeof serverSupabase>>>;

export async function currentProfile(supabase: Supabase): Promise<Profile | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase.from("profiles")
    .select("id, display_name, role")
    .eq("id", user.id)
    .maybeSingle<Profile>();

  if (error) throw error;
  return data;
}
