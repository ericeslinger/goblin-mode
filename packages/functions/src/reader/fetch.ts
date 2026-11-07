// The production feed fetcher (#161): a public request with the
// conditional headers, the feed size cap, and the body as text in the
// charset the site declared.
import { type PageFetcher, publicRequest } from '../attachments/import';
import { FEED_MAX_BYTES, type FeedFetcher } from './refresh';

/** The most of a page or a candidate feed read while discovering (#174). */
export const DISCOVER_MAX_BYTES = 2 * 1024 * 1024;

/** The body decoded by the content type's charset, UTF-8 when none or unknown. */
export function decodeBody(bytes: Uint8Array, contentType: string): string {
  const charset = /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

export const feedFetch: FeedFetcher = async (url, seen) => {
  const res = await publicRequest(url, {
    maxBytes: FEED_MAX_BYTES,
    userAgent: 'Mossgoblin/1 (feed reader)',
    headers: {
      accept:
        'application/rss+xml, application/atom+xml, application/feed+json, application/xml, text/xml, application/json;q=0.9, */*;q=0.5',
      ...(seen.etag ? { 'if-none-match': seen.etag } : {}),
      ...(seen.lastModified ? { 'if-modified-since': seen.lastModified } : {}),
    },
  });
  return {
    status: res.status,
    contentType: res.contentType,
    text: res.status === 304 ? '' : decodeBody(res.bytes, res.contentType),
    ...(res.header('etag') ? { etag: res.header('etag') } : {}),
    ...(res.header('last-modified') ? { lastModified: res.header('last-modified') } : {}),
  };
};

/**
 * Discovery's look at a pasted address (#174): a page or a feed, at
 * most 2 MB, a reason to show when it does not answer.
 */
export const discoverPageFetch: PageFetcher = async (url) => {
  const res = await publicRequest(url, {
    maxBytes: DISCOVER_MAX_BYTES,
    userAgent: 'Mossgoblin/1 (feed reader)',
    headers: {
      accept:
        'text/html, application/xhtml+xml, application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, */*;q=0.5',
    },
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`the site answered ${res.status}`);
  return { contentType: res.contentType, bytes: res.bytes };
};

/** Discovery's look at a candidate feed (#174): the feed fetcher with discovery's cap. */
export const discoverFeedFetch: FeedFetcher = async (url) => {
  const res = await publicRequest(url, {
    maxBytes: DISCOVER_MAX_BYTES,
    userAgent: 'Mossgoblin/1 (feed reader)',
    headers: {
      accept:
        'application/rss+xml, application/atom+xml, application/feed+json, application/xml, text/xml, application/json;q=0.9, */*;q=0.5',
    },
  });
  return {
    status: res.status,
    contentType: res.contentType,
    text: decodeBody(res.bytes, res.contentType),
  };
};
