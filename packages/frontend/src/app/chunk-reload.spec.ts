import { isChunkLoadError, loadAfresh, reloadOnChunkError } from './chunk-reload';

function store() {
  const held = new Map<string, string>();
  return {
    getItem: (k: string) => held.get(k) ?? null,
    setItem: (k: string, v: string) => void held.set(k, v),
  };
}

const gone = new TypeError(
  'Failed to fetch dynamically imported module: http://localhost/chunk-DlMsMMG1.js',
);

describe('reloadOnChunkError (#312)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('knows a lazy chunk that failed to load, in each browser’s words', () => {
    expect(isChunkLoadError(gone)).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('No habit'))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });

  it('loads the address asked for afresh, once', () => {
    const load = vi.spyOn(loadAfresh, 'run').mockImplementation(() => undefined);
    const s = store();
    reloadOnChunkError({ error: gone, url: '/settings' }, s, 1000);
    expect(load).toHaveBeenCalledWith('/settings');
    // The same address failing again at once is left alone: no loop.
    reloadOnChunkError({ error: gone, url: '/settings' }, s, 2000);
    expect(load).toHaveBeenCalledTimes(1);
    // Another address, or the same one a minute on, is tried again.
    reloadOnChunkError({ error: gone, url: '/habits' }, s, 3000);
    reloadOnChunkError({ error: gone, url: '/habits' }, s, 3000 + 60_000);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('leaves any other error, and a device that cannot remember, alone', () => {
    const load = vi.spyOn(loadAfresh, 'run').mockImplementation(() => undefined);
    reloadOnChunkError({ error: new Error('No habit'), url: '/habits' }, store(), 1);
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    };
    reloadOnChunkError({ error: gone, url: '/settings' }, full, 1);
    expect(load).not.toHaveBeenCalled();
  });
});
