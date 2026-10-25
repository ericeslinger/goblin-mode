import { describe, expect, it, vi } from 'vitest';
import { localSealer } from './local-sealer';
import { NoKeyError, withKey } from './use';

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';

async function deps(kept = true) {
  const sealer = localSealer('spec');
  const ciphertext = kept ? await sealer.seal('u1', 'anthropic', KEY) : undefined;
  return {
    store: {
      put: vi.fn(),
      drop: vi.fn(),
      ciphertext: vi.fn(async () => ciphertext),
    },
    sealer,
    marks: { markUsed: vi.fn(async () => undefined), markBroken: vi.fn(async () => undefined) },
  };
}

describe('withKey (#144)', () => {
  it('says where to add a key when none is kept', async () => {
    const d = await deps(false);
    const use = vi.fn();
    await expect(withKey(d, 'u1', 'anthropic', 'transcribe', use)).rejects.toBeInstanceOf(
      NoKeyError,
    );
    await expect(withKey(d, 'u1', 'gemini', 'transcribe', use)).rejects.toThrow(
      'Add a Gemini key in Settings, AI assistants, to transcribe.',
    );
    expect(use).not.toHaveBeenCalled();
  });

  it('hands the key to the call alone, and marks it used', async () => {
    const d = await deps();
    expect(await withKey(d, 'u1', 'anthropic', 'transcribe', async (k) => k.length)).toBe(
      KEY.length,
    );
    expect(d.marks.markUsed).toHaveBeenCalledWith('u1', 'anthropic');
    expect(d.marks.markBroken).not.toHaveBeenCalled();
  });

  it('marks the key broken when the provider refuses it, and keeps the key out of errors', async () => {
    const d = await deps();
    const refused = Object.assign(new Error(`401 invalid x-api-key ${KEY}`), { status: 401 });
    await expect(
      withKey(d, 'u1', 'anthropic', 'transcribe', async () => {
        throw refused;
      }),
    ).rejects.toThrow(
      'Anthropic no longer accepts your key; replace it in Settings, AI assistants.',
    );
    expect(d.marks.markBroken).toHaveBeenCalledWith('u1', 'anthropic');
    expect(d.marks.markUsed).not.toHaveBeenCalled();

    const other = Object.assign(new Error(`overloaded, sent ${KEY}`), { status: 529 });
    await expect(
      withKey(d, 'u1', 'anthropic', 'transcribe', async () => {
        throw other;
      }),
    ).rejects.toThrow('overloaded, sent [key]');
    // A 403 is a key short of a model or feature, not a bad key.
    const short = Object.assign(new Error('forbidden'), { status: 403 });
    await expect(
      withKey(d, 'u1', 'anthropic', 'transcribe', async () => {
        throw short;
      }),
    ).rejects.toThrow('forbidden');
    expect(d.marks.markBroken).toHaveBeenCalledTimes(1);
  });

  it('leaves a key saved during the call alone, and never fails a call over a mark', async () => {
    const d = await deps();
    const refused = Object.assign(new Error('401'), { status: 401 });
    const replaced = await d.sealer.seal('u1', 'anthropic', 'sk-ant-api03-newkeynewkeynewkey0123');
    d.store.ciphertext.mockResolvedValueOnce(await d.sealer.seal('u1', 'anthropic', KEY));
    d.store.ciphertext.mockResolvedValueOnce(replaced);
    await expect(
      withKey(d, 'u1', 'anthropic', 'transcribe', async () => {
        throw refused;
      }),
    ).rejects.toThrow('no longer accepts');
    expect(d.marks.markBroken).not.toHaveBeenCalled();

    d.marks.markUsed.mockRejectedValueOnce(new Error('firestore down'));
    expect(await withKey(d, 'u1', 'anthropic', 'transcribe', async () => 'done')).toBe('done');
    d.marks.markBroken.mockRejectedValueOnce(new Error('firestore down'));
    await expect(
      withKey(d, 'u1', 'anthropic', 'transcribe', async () => {
        throw refused;
      }),
    ).rejects.toThrow('no longer accepts');
  });
});
