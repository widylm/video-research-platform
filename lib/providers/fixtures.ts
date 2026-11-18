import type { Platform, Video } from "@/lib/videos";

const fixtures = [
  ["tiktok", "coffee", "Медленное утро и кофе дома", "brew.notes",
    "Готовим фильтр-кофе и собираем уютный утренний ритуал.", ["кофе", "утро", "лайфстайл"], "2026-11-16", 284000, 18900],
  ["instagram", "travel", "Маршрут на выходные в горах", "trail.diary",
    "Два дня в горах: тропы, виды и места для остановок.", ["путешествия", "горы", "маршрут"], "2026-11-15", 198500, 12600],
  ["tiktok", "style", "Как собрать осенний гардероб", "layer.studio",
    "Пять базовых вещей для осени и идеи, с чем их сочетать.", ["стиль", "мода", "осень"], "2026-11-14", 412000, 32700],
  ["instagram", "interior", "Маленькая квартира, большой уют", "room.by.room",
    "Перестановка, тёплый свет и несколько находок для гостиной.", ["интерьер", "дом", "дизайн"], "2026-11-13", 152000, 9800],
  ["tiktok", "studio", "Рабочий день в творческой студии", "desk.tales",
    "От первого эскиза до готовой идеи: один день за рабочим столом.", ["дизайн", "работа", "лайфстайл"], "2026-11-12", 96500, 7200],
  ["instagram", "breakfast", "Три идеи для быстрого завтрака", "morning.plate",
    "Простые рецепты для утра, когда на готовку всего десять минут.", ["еда", "рецепты", "утро"], "2026-11-10", 307000, 21400],
  ["tiktok", "city", "Вечерняя прогулка по городу", "city.frames",
    "Снимаем городской свет и ищем новые ракурсы в знакомых местах.", ["город", "съёмка", "лайфстайл"], "2026-11-08", 72300, 4100],
  ["instagram", "fitness", "Короткая тренировка на всё тело", "move.daily",
    "Четыре упражнения для домашней тренировки без тренажёров.", ["спорт", "тренировка", "дом"], "2026-11-06", 131200, 8500],
] as const satisfies ReadonlyArray<readonly [Platform, string, string, string, string, readonly string[], string, number, number]>;

export const mockVideos: Video[] = fixtures.map(
  ([platform, slug, title, author, description, hashtags, date, views, likes], index) => ({
    id: `69000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    platform,
    externalId: `demo-${slug}`,
    url: null,
    author,
    title,
    description,
    hashtags: [...hashtags],
    publishedAt: `${date}T12:00:00.000Z`,
    views,
    likes,
    cover: `/covers/${slug}.webp`,
    isMock: true,
  }),
);
