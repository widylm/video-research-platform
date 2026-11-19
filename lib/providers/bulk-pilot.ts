import { bulkPlatforms, bulkPilotBudgetMicros, searchBulk, type BulkQuery, type BulkSearchProvider } from "../bulk-search.ts";

const themes = [
  { terms: "кофе дома рецепты coffee coffee at home recipe латте latte", text: "Кофе и домашние рецепты", tags: ["кофе", "рецепты"] },
  { terms: "город прогулка путешествия city walk travel", text: "Прогулка по городу", tags: ["город", "прогулка"] },
  { terms: "спорт тренировка fitness workout домашняя тренировка", text: "Тренировка дома", tags: ["спорт", "тренировка"] },
];
const rowsPerTheme = 600;

const pilotProviders: readonly BulkSearchProvider[] = bulkPlatforms.map((platform) => ({
  id: `mock:${platform}`,
  platform,
  billing: "free",
  quotePageMicros: () => 0,
  async fetchPage({ keywords, cursor, limit }) {
    const words = keywords.toLowerCase().split(/\s+/);
    const matches = themes.flatMap((theme, index) =>
      words.every((word) => theme.terms.includes(word)) ? [{ theme, index }] : []);
    const offset = cursor === null ? 0 : Number(cursor);
    const total = matches.length * rowsPerTheme;
    const end = Math.min(offset + limit, total);
    const items = Array.from({ length: end - offset }, (_, index) => {
      const matched = matches[Math.floor((offset + index) / rowsPerTheme)];
      const number = matched.index * rowsPerTheme + (offset + index) % rowsPerTheme + 1;
      return {
        externalId: platform === "tiktok" ? `2000000000${String(number).padStart(9, "0")}` : `pilot-reel-${number}`,
        url: null,
        originalTitle: number % 3 === 0 ? null : `Демо №${number}`,
        originalDescription: matched.theme.text,
        author: number % 4 === 0 ? null : `demo_${1 + number % 8}`,
        publishedAt: number % 7 === 0 ? null : "2026-11-01T12:00:00Z",
        views: number % 5 === 0 ? null : number * 13,
        likes: number % 7 === 0 ? null : number % 17,
        comments: number % 3 === 0 ? null : number % 8,
        hashtags: matched.theme.tags,
      };
    });
    return { items, nextCursor: end < total ? String(end) : null, chargedMicros: 0 };
  },
}));

export function runBulkPilot(query: BulkQuery) {
  return searchBulk(query, pilotProviders, { budgetMicros: bulkPilotBudgetMicros });
}
