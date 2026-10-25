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

    const other = Object.assign(new Error('overloaded'), { status: 529 });
    await expect(
      withKey(d, 'u1', 'anthropic', 'transcribe', async () => {
        throw other;
      }),
    ).rejects.toThrow('overloaded');
    expect(d.marks.markBroken).toHaveBeenCalledTimes(1);
  });
});
