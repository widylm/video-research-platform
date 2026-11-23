// Extraction functions below come from the user's working Fashion Radar collector.
// This adapter preserves the full caption and adds counters the local UI discarded.
import { normalizeItem, nonnegative } from './extract.mjs';
import { instagramItem, instagramIssue } from './instagram.mjs';
import { pageIssue, explicitEmptyPage } from './page-state.mjs';

export function discoveryUrl(platform, keywords, searchMode = 'hashtag') {
  const term = String(keywords).trim().normalize('NFC').replace(/^#/, '');
  if (!term || term.length > 120 || !['tiktok', 'instagram'].includes(platform)) return null;
  if (searchMode === 'hashtag') {
    if (!/^[\p{L}\p{N}_]{1,80}$/u.test(term)) return null;
    return platform === 'tiktok'
      ? `https://www.tiktok.com/tag/${encodeURIComponent(term)}`
      : `https://www.instagram.com/explore/tags/${encodeURIComponent(term)}/`;
  }
  if (searchMode !== 'keyword') return null;
  const url = new URL(platform === 'tiktok'
    ? 'https://www.tiktok.com/search/video'
    : 'https://www.instagram.com/explore/search/keyword/');
  url.searchParams.set('q', term);
  return url.toString();
}

const text = (value, max) => typeof value === 'string' ? value.replaceAll('\0', '').trim().slice(0, max) || null : null;
const count = (...values) => values.map(nonnegative).find(value => value !== null) ?? null;

export function extractMetadata(platform, data, fetchedAt = new Date().toISOString()) {
  const rows = new Map(), queue = [data];
  let visited = 0;
  while (queue.length && visited++ < 40_000) {
    const raw = queue.pop();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) && raw.length > 10_000) continue;
    const item = platform === 'tiktok' ? normalizeItem(raw) : instagramItem(raw);
    if (item) {
      const stats = raw.statsV2 ?? raw.stats ?? raw.statistics ?? raw;
      const hidden = raw.like_and_view_counts_disabled === true;
      const description = platform === 'tiktok' ? raw.desc
        : typeof raw.caption === 'string' ? raw.caption
          : raw.caption?.text ?? raw.edge_media_to_caption?.edges?.[0]?.node?.text;
      const row = {
        platform, externalId: platform === 'tiktok' ? item.id : item.id.slice(3),
        url: item.url, source: 'fashion-radar-browser', fetchedAt,
        originalTitle: null, originalDescription: text(description, 5_000),
        author: platform === 'tiktok' ? new URL(item.url).pathname.split('/')[1].slice(1)
          : text(raw.user?.username ?? raw.owner?.username ?? raw.username, 128),
        publishedAt: item.published_at, views: item.views, likes: item.likes,
        comments: count(stats.commentCount, stats.comment_count, raw.comment_count,
          raw.comments_count, raw.edge_media_to_comment?.count, raw.edge_media_to_parent_comment?.count),
        hashtags: item.hashtags,
      };
      // Hidden fields must not be restored from an older response in this search.
      rows.set(row.externalId, hidden ? row : mergeMetadata(rows.get(row.externalId), row));
      continue;
    }
    for (const nested of Object.values(raw)) if (nested && typeof nested === 'object') queue.push(nested);
  }
  return [...rows.values()];
}

export function mergeMetadata(previous, next) {
  if (!previous) return next;
  return Object.fromEntries(Object.entries(next).map(([key, value]) => [key, value ?? previous[key] ?? null]));
}

export function pageProblem(platform, page) {
  if (/captcha|verify you are human|security check|подтвердите.{0,20}(человек|личность)/i.test(`${page.title ?? ''} ${page.text}`)
    || /\/(challenge|checkpoint)\//.test(page.url) || page.challenge) return 'manual_intervention_required';
  if (/\/(?:accounts\/)?(?:login|sign-in)(\/|\?|$)/.test(page.url)) return 'source_login_required';
  const problem = platform === 'instagram' ? instagramIssue(page) : pageIssue(page.text, page.links.length);
  // The local TikTok collector returns { phase, message }, whereas Instagram
  // returns a string. Testing the object itself loses the actual explanation.
  const message = typeof problem === 'string' ? problem : problem?.message;
  if (message && /captcha|ползунок|пазл|verify to continue/i.test(message)) return 'manual_intervention_required';
  if (message) return /вход|войти|login|log in/i.test(message) ? 'source_login_required' : 'source_not_ready';
  return null;
}

export function explicitlyEmpty(text) { return explicitEmptyPage(text); }

export function filterCollected(videos, query) {
  const f = query.filters;
  return videos.filter(video => (!f?.publishedFrom || video.publishedAt !== null && video.publishedAt >= f.publishedFrom)
    && (!f?.publishedTo || video.publishedAt !== null && video.publishedAt <= f.publishedTo)
    && (f?.minViews === undefined || video.views !== null && video.views >= f.minViews)
    && (f?.minLikes === undefined || video.likes !== null && video.likes >= f.minLikes))
    .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '') || a.externalId.localeCompare(b.externalId))
    .slice(0, query.limit);
}
