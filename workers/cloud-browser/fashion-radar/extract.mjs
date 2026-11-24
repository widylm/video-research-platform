// Only public video metadata is normalized; no cookies or raw responses are stored.
export function nonnegative(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
export function normalizeItem(item) {
  if (!item || typeof item !== 'object') return null;
  const id = String(item.id ?? item.aweme_id ?? '');
  const author = typeof item.author==='string'?item.author:item.author?.uniqueId??item.author?.unique_id;
  const stats = item.statsV2 ?? item.stats ?? item.statistics ?? {};
  if (!/^\d{10,25}$/.test(id) || !author || !/^[\w.]{1,100}$/.test(author)) return null;
  // Exclude photo slideshows rather than presenting them as videos.
  if (item.imagePost || item.image_post_info || (!item.video && !item.videoInfo)) return null;
  const epoch = Number(item.createTime ?? item.create_time);
  const published = Number.isFinite(epoch) && epoch > 0 && epoch < 4102444800 ? new Date(epoch * 1000).toISOString() : null;
  const desc = String(item.desc ?? '').slice(0, 1000);
  const hashtags = [...new Set([
    ...(item.challenges ?? []).map(x => x.title),
    ...(item.textExtra ?? []).map(x => x.hashtagName),
    ...Array.from(desc.matchAll(/#([\p{L}\p{N}_]+)/gu), x => x[1])
  ].filter(x => typeof x === 'string' && /^[\p{L}\p{N}_]{1,80}$/u.test(x)).map(x => x.toLowerCase()))];
  return { id, url: `https://www.tiktok.com/@${author}/video/${id}`, title: desc,
    hashtags, published_at: published, views: nonnegative(stats.playCount ?? stats.play_count),
    likes: nonnegative(stats.diggCount ?? stats.digg_count), source: 'public-page-data' };
}
export function extractItems(data) {
  const found = new Map(), queue = [data]; let visited = 0;
  while (queue.length && visited++ < 40000) {
    const value = queue.pop();
    if (!value || typeof value !== 'object') continue;
    const item = normalizeItem(value);
    if (item) { found.set(item.id, item); continue; }
    for (const nested of Object.values(value).reverse()) if (nested && typeof nested === 'object') queue.push(nested);
  }
  return [...found.values()];
}
export function normalizeLink(href, title = '') {
  try {
    const u = new URL(href), match = u.pathname.match(/^\/@([\w.]+)\/video\/(\d{10,25})\/?$/);
    if (u.protocol !== 'https:' || u.hostname !== 'www.tiktok.com' || !match) return null;
    return { id: match[2], url: `https://www.tiktok.com/@${match[1]}/video/${match[2]}`,
      title: String(title).slice(0,1000), hashtags: [], published_at: null, views: null, likes: null, source: 'visible-link' };
  } catch { return null; }
}
export function validHashtag(value) {
  const tag = String(value ?? '').trim().replace(/^#/, '').toLowerCase();
  if (!/^[\p{L}\p{N}_]{1,80}$/u.test(tag)) throw new Error('Введи один хэштег: буквы, цифры и подчёркивание, без пробелов.');
  return tag;
}
