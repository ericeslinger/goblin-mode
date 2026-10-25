// A gardener's own AI provider keys (#144, Eric's BYOK design,
// 2026-10-25): pasted in Settings, sent to the saveKey callable, checked
// with the provider, encrypted with Cloud KMS and kept server-only. The
// app reads back only this masked record, under settings/keys.
import { z } from 'zod';
import { Timestamp } from './model';

export const PROVIDERS = ['anthropic', 'gemini', 'openrouter'] as const;
export type Provider = (typeof PROVIDERS)[number];
export const Provider = z.enum(PROVIDERS);

/** How each provider is named to the gardener, and what its keys start with. */
export const PROVIDER_INFO: Record<Provider, { name: string; prefix: string; pattern: RegExp }> = {
  anthropic: { name: 'Anthropic', prefix: 'sk-ant-', pattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/ },
  gemini: { name: 'Gemini', prefix: 'AIza', pattern: /^AIza[A-Za-z0-9_-]{30,}$/ },
  openrouter: { name: 'OpenRouter', prefix: 'sk-or-', pattern: /^sk-or-[A-Za-z0-9_-]{20,}$/ },
};

/** Whether `key` is shaped like one of the provider's, before any call. */
export function keyLooksRight(provider: Provider, key: string): boolean {
  return PROVIDER_INFO[provider].pattern.test(key);
}

/** What the app shows of a key, ever: its prefix and last four characters. */
export function maskKey(provider: Provider, key: string): string {
  return `${PROVIDER_INFO[provider].prefix}…${key.slice(-4)}`;
}

/** One provider's masked record, written by the functions only. */
export const KeyMeta = z.object({
  masked: z.string().min(1),
  updatedAt: Timestamp,
  /** When a feature last used it, and whether the provider last refused it. */
  lastUsedAt: Timestamp.optional(),
  broken: z.boolean().optional(),
});
export type KeyMeta = z.infer<typeof KeyMeta>;

/** The `settings/keys` doc: a field per provider the gardener has a key for. */
export const KeySettings = z.object({
  anthropic: KeyMeta.optional(),
  gemini: KeyMeta.optional(),
  openrouter: KeyMeta.optional(),
  updatedAt: Timestamp,
});
export type KeySettings = z.infer<typeof KeySettings>;
