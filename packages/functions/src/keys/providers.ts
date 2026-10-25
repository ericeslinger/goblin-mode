// One cheap call per provider to check a key before it is kept (#144):
// a typo or a revoked key is refused at once, not found out by a failed
// transcription later. Each call lists models, which spends nothing.
import { type Provider } from '@mossgoblin/schema';

export type KeyCheck = 'ok' | 'rejected' | 'unreachable';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const REQUESTS: Record<Provider, (key: string) => [string, RequestInit]> = {
  anthropic: (key) => [
    'https://api.anthropic.com/v1/models?limit=1',
    { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } },
  ],
  gemini: (key) => [
    'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
    { headers: { 'x-goog-api-key': key } },
  ],
  openrouter: (key) => [
    'https://openrouter.ai/api/v1/auth/key',
    { headers: { authorization: `Bearer ${key}` } },
  ],
};

/**
 * Whether the provider takes this key: 401 and 403 mean no; any other
 * failure means the provider could not be asked, which is not the key's
 * fault. The key itself goes only to the provider, never into an error.
 */
export async function checkKey(provider: Provider, key: string, fetch: Fetch): Promise<KeyCheck> {
  const [url, init] = REQUESTS[provider](key);
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    if (res.ok) return 'ok';
    if (res.status === 401 || res.status === 403) return 'rejected';
    return 'unreachable';
  } catch {
    return 'unreachable';
  }
}
