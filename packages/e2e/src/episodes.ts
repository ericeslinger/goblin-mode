import type { Page, Route } from '@playwright/test';

// The fixture podcast's audio (#179, #180), for the journeys that play
// and download its episodes (podcasts.spec.ts since #245).

/**
 * The fixture episode's audio (#179): six seconds of silence, 8 kHz
 * 8-bit mono PCM, so it plays in the browser and ends soon.
 */
export function silentWav(seconds = 6, rate = 8000): Buffer {
  const samples = seconds * rate;
  const wav = Buffer.alloc(44 + samples, 0x80);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + samples, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples, 40);
  return wav;
}

/**
 * The fixture show's own artwork (#246), `itunes:image` on its channel:
 * a one-pixel PNG, so the Shows grid draws a real image for it.
 */
export const SHOW_ART = 'https://pod.invalid/show.jpg';
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * The fixture feed's enclosures (pod.invalid) cannot be reached from
 * the browser: the episodes' audio is the silent file, served here,
 * a byte range when one is asked for; the show's artwork is the pixel
 * (#246), and an episode's own artwork is refused, so its square
 * stands in. On the context, not the page: the service worker's
 * fetches are the context's.
 */
export async function serveEpisodes(page: Page): Promise<void> {
  const wav = silentWav();
  await page.context().route(/^https:\/\/pod\.invalid\//, (route) => {
    const url = route.request().url();
    if (url === SHOW_ART)
      return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
    if (!url.endsWith('.mp3')) return route.abort();
    return answerWav(route, wav);
  });
}

/** The silent file, or the byte range of it the request asks for. */
function answerWav(route: Route, wav: Buffer): Promise<void> {
  const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers()['range'] ?? '');
  if (!range) {
    return route.fulfill({
      status: 200,
      contentType: 'audio/wav',
      headers: { 'accept-ranges': 'bytes' },
      body: wav,
    });
  }
  const start = Number(range[1]);
  const end = range[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
  return route.fulfill({
    status: 206,
    contentType: 'audio/wav',
    headers: {
      'accept-ranges': 'bytes',
      'content-range': `bytes ${start}-${end}/${wav.length}`,
    },
    body: wav.subarray(start, end + 1),
  });
}

/**
 * The Worker's episode proxy (#180) has no stand-in in the e2e suite:
 * the app is served by scripts/serve-static.mjs, not by the Worker, and
 * the Worker checks real Google-signed tokens. The journey answers
 * `/api/episode?url=…` here instead, as the proxy would for the fixture
 * episode, and records each request's Authorization header. On the
 * context, so the service worker's fetches on a cache miss reach it.
 */
export async function serveProxy(page: Page): Promise<string[]> {
  const wav = silentWav();
  const asked: string[] = [];
  await page.context().route(/\/api\/episode\?/, async (route) => {
    asked.push((await route.request().allHeaders())['authorization'] ?? '');
    const link = new URL(route.request().url()).searchParams.get('url') ?? '';
    if (!/^https:\/\/pod\.invalid\/.*\.mp3$/.test(link)) return route.fulfill({ status: 415 });
    return answerWav(route, wav);
  });
  return asked;
}
