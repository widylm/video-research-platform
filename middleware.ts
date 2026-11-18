import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseConfig } from "@/lib/supabase-config";

export async function middleware(request: NextRequest) {
  const config = supabaseConfig();
  let response = NextResponse.next({ request });
  if (!config) return response;

  const supabase = createServerClient(config.url, config.key, {
    cookieOptions: { httpOnly: true, secure: process.env.NODE_ENV === "production" },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(values, headers) {
        values.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        values.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        Object.entries(headers ?? {}).forEach(([key, value]) => response.headers.set(key, value));
      },
    },
  });

  // getSession refreshes expired cookies here. Access decisions use getUser on the server.
  await supabase.auth.getSession();
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = { matcher: ["/", "/login"] };
