import type { BulkQuery, BulkVideo } from '../../../lib/bulk-search.ts';
import type { CloudBrowserErrorCode } from '../../../lib/cloud-browser-contract.ts';
export function discoveryUrl(platform: string, keywords: string, searchMode?: string): string | null;
export function extractMetadata(platform: string, data: unknown, fetchedAt?: string): BulkVideo[];
export function mergeMetadata(previous: BulkVideo | undefined, next: BulkVideo): BulkVideo;
export function pageProblem(platform: string, page: { url: string; title?: string; text: string; links: string[]; challenge?: boolean }): CloudBrowserErrorCode | null;
export function explicitlyEmpty(text: string): boolean;
export function filterCollected(videos: BulkVideo[], query: BulkQuery): BulkVideo[];
