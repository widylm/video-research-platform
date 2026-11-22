"use server";

import { z } from "zod";
import { discoverInstagram, instagramDiscoveryConfig, normalizeHashtag } from "@/lib/instagram-discovery";
import { workspace } from "@/lib/workspace";

const inputSchema = z.object({
  hashtag: z.string().max(81),
  days: z.union([z.literal(0), z.literal(7), z.literal(30)]),
  minViews: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  minLikes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export async function searchInstagram(input: unknown) {
  const session = await workspace();
  if (session.mode !== "team" || session.profile.role === "viewer") {
    return { error: "Поиск доступен участникам команды и администраторам." };
  }
  const config = instagramDiscoveryConfig(process.env);
  if (!config) return { error: "Администратору нужно подключить Instagram." };

  const parsed = inputSchema.safeParse(input);
  const hashtag = parsed.success ? normalizeHashtag(parsed.data.hashtag) : null;
  if (!parsed.success || !hashtag) return { error: "Укажи один хэштег и проверь фильтры." };

  const { days, minViews, minLikes } = parsed.data;
  const result = await discoverInstagram(config, hashtag, days, minViews, minLikes);
  if (result.failedAccounts === result.accountCount) {
    return { error: result.rateLimited
      ? "Instagram временно ограничил запросы. Попробуй позже."
      : "Instagram не вернул данные. Администратору нужно проверить подключение." };
  }
  return { result };
}
