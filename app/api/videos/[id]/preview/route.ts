import { readTikTokPreview } from "@/lib/public-video-url";
import { videoIdSchema } from "@/lib/video-entry";
import { workspace } from "@/lib/workspace";

const options = { headers: { "Cache-Control": "private, no-store" } };

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!videoIdSchema.safeParse(id).success) return Response.json(null, { ...options, status: 404 });

  try {
    const session = await workspace();
    if (session.mode !== "team") return Response.json(null, { ...options, status: 401 });
    const { data, error } = await session.supabase.from("videos").select("url")
      .eq("id", id).eq("platform", "tiktok").eq("is_mock", false).maybeSingle();
    if (error || !data?.url) return Response.json(null, { ...options, status: 404 });

    // Cache only sanitized public metadata after verifying access to the saved video.
    const cache = typeof caches === "undefined" ? undefined
      : await caches.open("kadr-tiktok-previews-v1").catch(() => undefined);
    const key = new URL(`/api/videos/${id}/preview`, request.url).href;
    const cached = await cache?.match(key).catch(() => undefined);
    if (cached) return Response.json(await cached.json(), options);

    const preview = await readTikTokPreview(data.url);
    await cache?.put(key, Response.json(preview, { headers: { "Cache-Control": "max-age=600" } })).catch(() => {});
    return Response.json(preview, options);
  } catch {
    return Response.json(null, options);
  }
}
