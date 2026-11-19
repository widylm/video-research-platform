"use server";

import { redirect } from "next/navigation";
import { libraryCommand, type Library } from "@/lib/library";
import { checkVideoEmbed, resolveVideoLink } from "@/lib/public-video-url";
import { searchVideos } from "@/lib/providers";
import { currentProfile, serverSupabase } from "@/lib/supabase";
import { videoDetailsSchema, videoEntrySchema } from "@/lib/video-entry";
import { platformVideoTitle, searchSchema, type Video } from "@/lib/videos";
import { attachCoverRevisions, changeLibrary, readLibrary, searchCatalog, toVideo, videoColumns, workspace, type SavedVideoRow, type VideoRow } from "@/lib/workspace";

type ActionResult<T> = { data: T } | { error: string };
const authError = { error: "Войдите в аккаунт команды, чтобы продолжить." };
const libraryError = { error: "Не удалось обновить данные. Проверьте доступ и повторите попытку." };

export async function runSearch(input: unknown, record = true): Promise<ActionResult<Video[]>> {
  const parsed = searchSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues.find((entry) => entry.path[0] === "from");
    return { error: issue?.code === "custom" ? issue.message : "Проверьте даты, текст и числовые параметры поиска." };
  }

  try {
    const session = await workspace();
    if (session.mode === "locked") return authError;
    if (session.mode === "demo") return { data: await searchVideos(parsed.data) };
    const results = await searchCatalog(session.supabase, parsed.data);
    if (record) {
      const { error } = await session.supabase.from("search_jobs").insert({
        query: parsed.data, provider: "catalog", result_count: results.length,
      });
      if (error) throw error;
    }
    return { data: results };
  } catch {
    return { error: "Не удалось выполнить поиск. Попробуйте ещё раз." };
  }
}

export async function savePublicVideo(input: unknown): Promise<ActionResult<{ video: Video; created: boolean }>> {
  const parsed = videoEntrySchema.safeParse(input);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    if (field === "url") return { error: "Вставьте полную или короткую ссылку на видео." };
    if (field === "title") return { error: "Название должно быть не длиннее 120 символов." };
    if (field === "hashtags") return { error: "Введите до 30 хэштегов через пробел или запятую. Используйте буквы, цифры и подчёркивания." };
    if (field === "views" || field === "likes") return { error: "Введите целое неотрицательное число или оставьте поле пустым." };
    return { error: "Проверьте дату, длину описания и выбранную коллекцию." };
  }

  try {
    const session = await workspace();
    if (session.mode !== "team") return authError;
    if (session.profile.role === "viewer") return { error: "Добавлять видео могут администраторы и участники." };

    const result = await resolveVideoLink(parsed.data.url);
    if ("error" in result) return result;
    const { platform, externalId, url, author } = result.video;
    const { description, publishedAt, hashtags, views, likes, collectionId } = parsed.data;
    const firstLine = description.split(/\r?\n/, 1)[0]?.trim();
    const title = parsed.data.title || (firstLine ? Array.from(firstLine).slice(0, 100).join("") : platformVideoTitle(platform));

    const { data, error } = await session.supabase.rpc("save_public_video", {
      p_platform: platform, p_external_id: externalId, p_url: url, p_author: author,
      p_title: title, p_description: description, p_hashtags: hashtags, p_published_at: publishedAt,
      p_views: views, p_likes: likes, p_collection_id: collectionId,
    }).returns<SavedVideoRow[]>().single();
    if (error?.code === "42501" || error?.code === "23503") {
      return { error: collectionId ? "Коллекция недоступна. Выберите другую коллекцию или сохраните видео в каталог."
        : "У вас нет прав на добавление видео." };
    }
    if (error) throw error;
    const [video] = await attachCoverRevisions(session.supabase, [toVideo(data.video)]);
    return { data: { video, created: data.created } };
  } catch {
    return { error: "Не удалось сохранить видео. Попробуйте ещё раз." };
  }
}

export async function updateVideoDetails(input: unknown): Promise<ActionResult<Video>> {
  const parsed = videoDetailsSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.path[0] === "author"
      ? "Укажите имя пользователя Instagram до 30 символов, без пробелов."
      : "Введите название и проверьте длину описания." };
  }

  try {
    const session = await workspace();
    if (session.mode !== "team") return authError;
    if (session.profile.role === "viewer") return { error: "Редактировать видео могут администраторы и участники." };

    const { id, author, title, description } = parsed.data;
    const update = session.supabase.from("videos")
      .update(author === undefined ? { title, description } : { title, description, author })
      .eq("id", id).eq("is_mock", false);
    if (author !== undefined) update.eq("platform", "instagram");
    const { data, error } = await update.select(videoColumns).maybeSingle<VideoRow>();
    if (error) throw error;
    if (!data) return { error: "Карточка недоступна для редактирования." };
    const [video] = await attachCoverRevisions(session.supabase, [toVideo(data)]);
    return { data: video };
  } catch {
    return { error: "Не удалось обновить карточку. Попробуйте ещё раз." };
  }
}

export async function checkSavedVideo(videoId: string) {
  try {
    const session = await workspace();
    if (session.mode !== "team") return "unknown";
    const { data, error } = await session.supabase.from("videos").select("url")
      .eq("id", videoId).eq("is_mock", false).maybeSingle();
    return !error && data?.url ? await checkVideoEmbed(data.url) : "unknown";
  } catch {
    return "unknown";
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
