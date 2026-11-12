import type { SettingsApi } from './theme-sync.service';

/**
 * Keep until acknowledged, for settings docs (#224; DESIGN.md, Client,
 * Saving), as notes are kept (#198, #200): a write through the
 * persistent cache is taken in a moment later (IndexedDB), and a reload
 * in that moment lost a theme just chosen to the older cached doc. So
 * each write is kept on the device at once, under its doc's path (which
 * carries the uid, so it is never replayed into another account), and
 * forgotten when the write settles: acknowledged, the server has it;
 * refused, it is never replayed. A write left from an earlier load is
 * written again as its doc is first listened to, before the listener,
 * so the first snapshot carries it as this device's own pending write.
 */
export const KEPT_SETTINGS_KEY = 'goblin.pendingSettings';

/** What is kept for one doc: the fields not yet acknowledged, in JSON. */
export interface KeptSetting {
  /** The latest write's number: an earlier one settling leaves it kept. */
  seq: number;
  /** Merge writes only so far; one whole write makes the record whole. */
  merge: boolean;
  data: Record<string, unknown>;
}

/** Stands for the server's time (`now()`) in a kept write. */
const NOW_KEY = 'goblin.serverTime';

/** A value with no JSON form other than the server's time. */
class Unkeepable extends Error {}

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

const isNowMark = (v: unknown): boolean =>
  isPlain(v) && v[NOW_KEY] === true && Object.keys(v).length === 1;

function encode(v: unknown, isNow: (v: unknown) => boolean): unknown {
  if (isNow(v)) return { [NOW_KEY]: true };
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (Array.isArray(v)) return v.map((x) => encode(x, isNow));
  if (isPlain(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      // Firestore refuses undefined; JSON drops it the same way.
      if (x !== undefined) out[k] = encode(x, isNow);
    }
    return out;
  }
  // A Timestamp, deleteField() or anything else JSON would change.
  throw new Unkeepable();
}

function decode(v: unknown, now: () => unknown): unknown {
  if (isNowMark(v)) return now();
  if (Array.isArray(v)) return v.map((x) => decode(x, now));
  if (isPlain(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = decode(x, now);
    return out;
  }
  return v;
}

/** `change` over `base` as a merge write lands: maps field by field, the rest replaced. */
export function mergeFields(
  base: Record<string, unknown>,
  change: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(change)) {
    const was = out[k];
    out[k] =
      isPlain(v) && !isNowMark(v) && isPlain(was) && !isNowMark(was) ? mergeFields(was, v) : v;
  }
  return out;
}

function isKept(v: unknown): v is KeptSetting {
  return (
    isPlain(v) &&
    typeof v['seq'] === 'number' &&
    typeof v['merge'] === 'boolean' &&
    isPlain(v['data'])
  );
}

/**
 * The record of a doc's unacknowledged writes, on `storage`. Every call
 * tolerates storage missing, full or corrupt: writes then go as they
 * did before, unkept.
 */
export class KeptSettings {
  /** Paths written or replayed this load: nothing of theirs is left from an earlier one. */
  private readonly touched = new Set<string>();
  /** The last write number used here, so one never repeats in a load. */
  private last = 0;

  constructor(
    private readonly storage: Storage | null,
    private readonly isNow: (v: unknown) => boolean,
  ) {}

  /** The record for `path`, or undefined (none, unreadable, or in an old shape). */
  get(path: string): KeptSetting | undefined {
    try {
      const raw = this.storage?.getItem(key(path));
      if (raw == null) return undefined;
      const parsed: unknown = JSON.parse(raw);
      return isKept(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Keeps a write as it is made; its number, for `settled`, or
   * undefined when it is not kept. A write that cannot be kept (storage
   * refused, a value JSON would change) drops the record too, so an
   * older write is never replayed over it.
   */
  record(path: string, data: Record<string, unknown>, merge: boolean): number | undefined {
    this.touched.add(path);
    if (!this.storage) return undefined;
    const prev = this.get(path);
    const seq = Math.max(prev?.seq ?? 0, this.last) + 1;
    this.last = seq;
    try {
      const fields = encode(data, this.isNow) as Record<string, unknown>;
      const next: KeptSetting =
        merge && prev
          ? { seq, merge: prev.merge, data: mergeFields(prev.data, fields) }
          : { seq, merge, data: fields };
      this.storage.setItem(key(path), JSON.stringify(next));
      return seq;
    } catch {
      this.forget(path);
      return undefined;
    }
  }

  /** A write settled: its record goes, unless a later write was kept since. */
  settled(path: string, seq: number): void {
    if (this.get(path)?.seq === seq) this.forget(path);
  }

  /**
   * The write left for `path` from an earlier load, to make again, with
   * `now()` for its server times; once a load, and never for a path
   * already written in this one.
   */
  takeLeft(
    path: string,
    now: () => unknown,
  ): { data: Record<string, unknown>; merge: boolean } | undefined {
    if (this.touched.has(path)) return undefined;
    this.touched.add(path);
    const left = this.get(path);
    if (!left) return undefined;
    return { data: decode(left.data, now) as Record<string, unknown>, merge: left.merge };
  }

  /** Drops the record for `path`, whatever it holds. */
  drop(path: string): void {
    this.forget(path);
  }

  private forget(path: string): void {
    try {
      this.storage?.removeItem(key(path));
    } catch {
      // Nothing more to do.
    }
  }
}

const key = (path: string) => `${KEPT_SETTINGS_KEY}.${path}`;

/**
 * `api` with its writes kept until acknowledged (see above). Its own
 * `now()` is the only server time a kept write may carry.
 */
export function keepUntilAcknowledged(api: SettingsApi, storage: Storage | null): SettingsApi {
  const issued = new WeakSet<object>();
  const isNow = (v: unknown) => typeof v === 'object' && v !== null && issued.has(v);
  const now = () => {
    const t = api.now();
    if (typeof t === 'object' && t !== null) issued.add(t);
    return t;
  };
  const kept = new KeptSettings(storage, isNow);
  const set: SettingsApi['set'] = (db, path, data, merge) => {
    const seq = kept.record(path, data, merge === true);
    const written = api.set(db, path, data, merge);
    if (seq !== undefined) {
      const done = () => kept.settled(path, seq);
      written.then(done, done);
    }
    return written;
  };
  return {
    listen: (db, path, next, error) => {
      const left = kept.takeLeft(path, now);
      if (left) {
        // A record the SDK will not take throws here, not in the
        // promise: forgotten, so the doc is still listened to, now and
        // on later loads (review on #259).
        try {
          set(db, path, left.data, left.merge).catch((err) =>
            console.error('kept settings write failed', err),
          );
        } catch (err) {
          console.error('kept settings write not made', err);
          kept.drop(path);
        }
      }
      return api.listen(db, path, next, error);
    },
    set,
    now,
  };
}
