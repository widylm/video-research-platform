"use server";

import { redirect } from "next/navigation";
import { libraryCommand, type Library } from "@/lib/library";
import { searchVideos } from "@/lib/providers";
import { currentProfile, serverSupabase } from "@/lib/supabase";
import { searchSchema, type Video } from "@/lib/videos";
import { changeLibrary, readLibrary, workspace } from "@/lib/workspace";

type ActionResult<T> = { data: T } | { error: string };
const authError = { error: "Войдите в аккаунт команды, чтобы продолжить." };
const libraryError = { error: "Не удалось обновить данные. Проверьте доступ и повторите попытку." };

export async function runSearch(input: unknown): Promise<ActionResult<Video[]>> {
  const parsed = searchSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues.find((entry) => entry.path[0] === "from");
    return { error: issue?.code === "custom" ? issue.message : "Проверьте даты, текст и числовые параметры поиска." };
  }

  try {
    const session = await workspace();
    if (session.mode === "locked") return authError;
    const results = await searchVideos(parsed.data);
    if (session.mode === "team") {
      const { error } = await session.supabase.from("search_jobs").insert({
        query: parsed.data, provider: "mock", result_count: results.length,
      });
      if (error) throw error;
    }
    return { data: results };
  } catch {
    return { error: "Не удалось выполнить поиск. Попробуйте ещё раз." };
  }
}

export async function refreshLibrary(): Promise<ActionResult<Library>> {
  try {
    const session = await workspace();
    if (session.mode !== "team") return authError;
    return { data: await readLibrary(session.supabase) };
  } catch {
    return libraryError;
  }
}

export async function updateLibrary(input: unknown): Promise<ActionResult<Library>> {
  const parsed = libraryCommand.safeParse(input);
  if (!parsed.success) return { error: "Проверьте данные для сохранения." };

  try {
    const session = await workspace();
    if (session.mode !== "team") return authError;
    await changeLibrary(session.supabase, session.profile, parsed.data);
    return { data: await readLibrary(session.supabase) };
  } catch {
    return libraryError;
  }
}

export async function signIn(_previous: string, form: FormData): Promise<string> {
  const supabase = await serverSupabase();
  if (!supabase) redirect("/");

  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!email || !password) return "Введите почту и пароль.";

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return "Не удалось войти. Проверьте почту, пароль и доступ к рабочему пространству.";

  try {
    if (!(await currentProfile(supabase))) {
      await supabase.auth.signOut({ scope: "local" });
      return "Этот аккаунт не добавлен в рабочее пространство. Обратитесь к администратору.";
    }
  } catch {
    await supabase.auth.signOut({ scope: "local" });
    return "Не удалось проверить доступ к рабочему пространству.";
  }

  redirect("/");
}

export async function signOut(): Promise<void> {
  const supabase = await serverSupabase();
  if (supabase) await supabase.auth.signOut({ scope: "local" });
  redirect("/login");
}
