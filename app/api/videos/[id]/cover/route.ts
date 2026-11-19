import { coverBucket, coverMaxBytes, coverType, isCoverJpeg } from "@/lib/video-cover";
import { videoIdSchema } from "@/lib/video-entry";
import { workspace } from "@/lib/workspace";

type Params = { params: Promise<{ id: string }> };
const noCache = { "Cache-Control": "private, no-store" };
const notFound = "Обложка недоступна.";

function error(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: noCache });
}

async function coverAccess({ params }: Params, write: boolean) {
  const { id } = await params;
  if (!videoIdSchema.safeParse(id).success) return error(notFound, 404);
  const session = await workspace();
  if (session.mode !== "team") return error("Войдите в аккаунт команды.", 401);
  if (write && session.profile.role === "viewer") {
    return error("Менять обложку могут администраторы и участники.", 403);
  }
  if (write) {
    const { data, error: queryError } = await session.supabase.from("videos")
      .select("id").eq("id", id).eq("is_mock", false).maybeSingle();
    if (queryError || !data) return error("Сохранённое видео недоступно.", 404);
  }
  return { files: session.supabase.storage.from(coverBucket), path: `${id.toLowerCase()}.jpg` };
}

export async function GET(_request: Request, params: Params) {
  try {
    const access = await coverAccess(params, false);
    if (access instanceof Response) return access;
    const { data } = await access.files.download(access.path);
    if (!data || data.size > coverMaxBytes) return error(notFound, 404);
    const bytes = await data.arrayBuffer();
    // Storage checks the supplied MIME type. Check the bytes again for direct Storage uploads.
    if (!isCoverJpeg(new Uint8Array(bytes))) return error(notFound, 404);
    return new Response(bytes, { headers: {
      ...noCache,
      "Content-Type": coverType,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch {
    return error(notFound, 404);
  }
}

async function readCover(request: Request) {
  if (Number(request.headers.get("content-length")) > coverMaxBytes || !request.body) return null;
  const reader = request.body.getReader();
  const bytes = new Uint8Array(coverMaxBytes);
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return bytes.subarray(0, size);
      if (size + value.length > coverMaxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      bytes.set(value, size);
      size += value.length;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function PUT(request: Request, params: Params) {
  if (request.headers.get("origin") !== new URL(request.url).origin) return error("Запрос отклонён.", 403);
  try {
    const access = await coverAccess(params, true);
    if (access instanceof Response) return access;
    if (request.headers.get("content-type") !== coverType) return error("Выберите изображение JPEG, PNG или WebP.", 415);
    const bytes = await readCover(request);
    if (!bytes) return error("Размер обложки превышает 512 КиБ.", 413);
    if (!isCoverJpeg(bytes)) return error("Не удалось прочитать изображение. Выберите другой файл.", 422);
    const { error: uploadError } = await access.files.upload(access.path, bytes, {
      contentType: coverType, cacheControl: "0", upsert: true,
    });
    if (uploadError) return error("Не удалось сохранить обложку. Проверьте настройки хранилища.", 502);
    return Response.json({ revision: crypto.randomUUID() }, { headers: noCache });
  } catch {
    return error("Не удалось сохранить обложку. Попробуйте ещё раз.", 500);
  }
}

export async function DELETE(request: Request, params: Params) {
  if (request.headers.get("origin") !== new URL(request.url).origin) return error("Запрос отклонён.", 403);
  try {
    const access = await coverAccess(params, true);
    if (access instanceof Response) return access;
    const { error: deleteError } = await access.files.remove([access.path]);
    if (deleteError) return error("Не удалось удалить обложку. Попробуйте ещё раз.", 502);
    return new Response(null, { status: 204, headers: noCache });
  } catch {
    return error("Не удалось удалить обложку. Попробуйте ещё раз.", 500);
  }
}
