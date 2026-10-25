import { describe, expect, it, vi } from 'vitest';
import { type KeyStore, KeyError, openKey, removeKey, saveKey } from './core';
import { type KeyCheck, checkKey } from './providers';
import { localSealer } from './local-sealer';
import { crc32c } from './sealer';

const ANTHROPIC = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';

function memoryStore(): KeyStore & { kept: Map<string, { ciphertext: string; masked: string }> } {
  const kept = new Map<string, { ciphertext: string; masked: string }>();
  return {
    kept,
    async put(uid, provider, ciphertext, masked) {
      kept.set(`${uid}/${provider}`, { ciphertext, masked });
    },
    async drop(uid, provider) {
      kept.delete(`${uid}/${provider}`);
    },
    async ciphertext(uid, provider) {
      return kept.get(`${uid}/${provider}`)?.ciphertext;
    },
  };
}

function deps(check: KeyCheck = 'ok') {
  return { store: memoryStore(), sealer: localSealer('spec'), check: vi.fn(async () => check) };
}

describe('saveKey (#144)', () => {
  it('refuses a key shaped wrong before asking anyone', async () => {
    const d = deps();
    await expect(
      saveKey(d, 'u1', 'anthropic', 'AIzaNotAnAnthropicKey0123456789012'),
    ).rejects.toThrow(/starts with sk-ant-/);
    await expect(saveKey(d, 'gemini', 'gemini', 'short')).rejects.toBeInstanceOf(KeyError);
    expect(d.check).not.toHaveBeenCalled();
  });

  it('checks with the provider, then keeps the key sealed and gives back only the mask', async () => {
    const d = deps();
    expect(await saveKey(d, 'u1', 'anthropic', `  ${ANTHROPIC}\n`)).toEqual({
      masked: 'sk-ant-…0123',
    });
    expect(d.check).toHaveBeenCalledWith('anthropic', ANTHROPIC);
    const kept = d.store.kept.get('u1/anthropic')!;
    expect(kept.masked).toBe('sk-ant-…0123');
    expect(kept.ciphertext).not.toContain('abcdefghij');
    expect(await openKey(d, 'u1', 'anthropic')).toBe(ANTHROPIC);
    expect(await openKey(d, 'u1', 'gemini')).toBeUndefined();
  });

  it('says when the provider refused the key, or could not be asked', async () => {
    await expect(saveKey(deps('rejected'), 'u1', 'anthropic', ANTHROPIC)).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'Anthropic did not accept this key.',
    });
    await expect(saveKey(deps('unreachable'), 'u1', 'anthropic', ANTHROPIC)).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('removes a key, and removing again is fine', async () => {
    const d = deps();
    await saveKey(d, 'u1', 'openrouter', 'sk-or-v1-abcdefghijklmnopqrstuvwxyz');
    await removeKey(d, 'u1', 'openrouter');
    await removeKey(d, 'u1', 'openrouter');
    expect(await openKey(d, 'u1', 'openrouter')).toBeUndefined();
  });
});

describe('sealer', () => {
  it('binds a ciphertext to its gardener and provider', async () => {
    const sealer = localSealer('spec');
    const sealed = await sealer.seal('u1', 'anthropic', ANTHROPIC);
    expect(sealed).not.toContain('abcdefghij');
    expect(await sealer.open('u1', 'anthropic', sealed)).toBe(ANTHROPIC);
    // Copied to another gardener's record, or another provider's field.
    await expect(sealer.open('u2', 'anthropic', sealed)).rejects.toThrow();
    await expect(sealer.open('u1', 'gemini', sealed)).rejects.toThrow();
    await expect(localSealer('other').open('u1', 'anthropic', sealed)).rejects.toThrow();
  });

  it('computes CRC32C as KMS does', () => {
    // The check value for "123456789" (RFC 3720, appendix B.4).
    expect(crc32c(Buffer.from('123456789'))).toBe(0xe3069283);
    expect(crc32c(Buffer.alloc(0))).toBe(0);
  });
});

describe('checkKey', () => {
  const answer = (status: number) => vi.fn(async () => new Response('', { status }));

  it('asks each provider for its models with the key, and reads the answer', async () => {
    const ok = answer(200);
    expect(await checkKey('anthropic', ANTHROPIC, ok)).toBe('ok');
    const [url, init] = ok.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('api.anthropic.com');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(ANTHROPIC);
    expect(await checkKey('gemini', 'AIza', answer(401))).toBe('rejected');
    expect(await checkKey('openrouter', 'sk-or-x', answer(403))).toBe('rejected');
    expect(await checkKey('openrouter', 'sk-or-x', answer(503))).toBe('unreachable');
    expect(
      await checkKey('anthropic', ANTHROPIC, async () => {
        throw new Error('ECONNRESET');
      }),
    ).toBe('unreachable');
  });
});
