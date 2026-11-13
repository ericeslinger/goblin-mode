// A small in-memory Firestore for unit specs: what the tools, the
// triggers' stores and put back use of it (note encryption specs,
// 2026-11-12 and 2026-11-13), so sealed paths run without the emulator.
// Imported by specs only, never from index.ts, so it reaches no bundle.
import {
  type DocumentSnapshot,
  FieldValue,
  type Firestore,
  Timestamp,
} from 'firebase-admin/firestore';

export type Data = Record<string, unknown>;
export type Store = Map<string, Data>;

/** A deep copy of plain objects and arrays; anything else as it is. */
export const copy = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(copy)
    : v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)]))
      : v;

const at = (d: Data | undefined, path: string): unknown =>
  path.split('.').reduce<unknown>((o, k) => (o as Data | undefined)?.[k], d);

const order = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : (v as number | string));

const DELETE = FieldValue.delete();

/** A sentinel as stored: a server time becomes now; a delete is handled by the caller. */
const resolved = (v: unknown): unknown =>
  v instanceof FieldValue && !v.isEqual(DELETE) ? Timestamp.now() : copy(v);

class Snap {
  constructor(
    readonly ref: Ref,
    private readonly stored: Data | undefined,
    private readonly fields?: string[],
  ) {}
  get id() {
    return this.ref.id;
  }
  get exists() {
    return this.stored !== undefined;
  }
  data(): Data | undefined {
    if (!this.stored) return undefined;
    const d = copy(this.stored) as Data;
    return this.fields
      ? Object.fromEntries(this.fields.map((f) => [f, d[f]]).filter(([, v]) => v !== undefined))
      : d;
  }
  get(field: string): unknown {
    return at(this.data(), field);
  }
}

function applyUpdate(base: Data, update: Data): Data {
  const out = copy(base) as Data;
  for (const [key, value] of Object.entries(update)) {
    const parts = key.split('.');
    let o = out;
    for (const p of parts.slice(0, -1)) o = (o[p] ??= {}) as Data;
    const last = parts[parts.length - 1];
    if (value instanceof FieldValue && value.isEqual(DELETE)) delete o[last];
    else o[last] = resolved(value);
  }
  return out;
}

class Ref {
  constructor(
    private readonly store: Store,
    readonly path: string,
  ) {}
  get id() {
    return this.path.split('/').pop()!;
  }
  collection(name: string) {
    return new Coll(this.store, `${this.path}/${name}`);
  }
  async get() {
    return new Snap(this, this.store.get(this.path));
  }
  async set(data: Data) {
    this.store.set(
      this.path,
      Object.fromEntries(Object.entries(data).map(([k, v]) => [k, resolved(v)])),
    );
  }
  async create(data: Data) {
    if (this.store.has(this.path)) throw new Error(`already a document ${this.path}`);
    await this.set(data);
  }
  async update(data: Data) {
    const had = this.store.get(this.path);
    if (!had) throw new Error(`no document ${this.path}`);
    this.store.set(this.path, applyUpdate(had, data));
  }
  async delete() {
    this.store.delete(this.path);
  }
}

type Filter = (d: Data) => boolean;

class Coll {
  constructor(
    private readonly store: Store,
    readonly path: string,
    private readonly filters: Filter[] = [],
    private readonly sort?: { field: string; dir: 'asc' | 'desc' },
    private readonly fields?: string[],
    private readonly max?: number,
  ) {}
  private with(o: { filter?: Filter; sort?: Coll['sort']; fields?: string[]; max?: number }) {
    return new Coll(
      this.store,
      this.path,
      o.filter ? [...this.filters, o.filter] : this.filters,
      o.sort ?? this.sort,
      o.fields ?? this.fields,
      o.max ?? this.max,
    );
  }
  doc(id: string) {
    return new Ref(this.store, `${this.path}/${id}`);
  }
  where(field: string, op: string, value: unknown) {
    const test: Record<string, (v: unknown) => boolean> = {
      '==': (v) => v === value,
      '!=': (v) => v !== undefined && v !== value,
      in: (v) => (value as unknown[]).includes(v),
      '>=': (v) => v !== undefined && order(v) >= order(value),
      '<': (v) => v !== undefined && order(v) < order(value),
    };
    return this.with({ filter: (d) => test[op](at(d, field)) });
  }
  orderBy(field: string, dir: 'asc' | 'desc' = 'asc') {
    return this.with({ sort: { field, dir }, filter: (d) => at(d, field) !== undefined });
  }
  select(...fields: string[]) {
    return this.with({ fields });
  }
  limit(n: number) {
    return this.with({ max: n });
  }
  async get() {
    let docs = [...this.store.entries()]
      .filter(
        ([p]) => p.startsWith(`${this.path}/`) && !p.slice(this.path.length + 1).includes('/'),
      )
      .filter(([, d]) => this.filters.every((f) => f(d)));
    if (this.sort) {
      const { field, dir } = this.sort;
      docs.sort(([, a], [, b]) => {
        const x = order(at(a, field));
        const y = order(at(b, field));
        return (x < y ? -1 : x > y ? 1 : 0) * (dir === 'desc' ? -1 : 1);
      });
    }
    if (this.max !== undefined) docs = docs.slice(0, this.max);
    const out = docs.map(([p, d]) => new Snap(new Ref(this.store, p), d, this.fields));
    return { docs: out, size: out.length, empty: out.length === 0 };
  }
}

class Writes {
  private readonly ops: (() => Promise<void>)[] = [];
  set(ref: Ref, data: Data) {
    this.ops.push(() => ref.set(data));
    return this;
  }
  create(ref: Ref, data: Data) {
    this.ops.push(() => ref.create(data));
    return this;
  }
  update(ref: Ref, data: Data) {
    this.ops.push(() => ref.update(data));
    return this;
  }
  delete(ref: Ref) {
    this.ops.push(() => ref.delete());
    return this;
  }
  async commit() {
    for (const op of this.ops) await op();
  }
}

class Tx extends Writes {
  get(target: Ref | Coll) {
    return target.get();
  }
  getAll(...refs: Ref[]) {
    return Promise.all(refs.map((r) => r.get()));
  }
}

/**
 * A Firestore over `store` (document path to data). A transaction's
 * writes land when its function returns, all or none: one that throws
 * writes nothing, as Firestore's.
 */
export function fakeDb(store: Store): Firestore {
  return {
    collection: (path: string) => new Coll(store, path),
    doc: (path: string) => new Ref(store, path),
    batch: () => new Writes(),
    getAll: (...refs: Ref[]) => Promise.all(refs.map((r) => r.get())),
    async runTransaction<R>(fn: (tx: Tx) => Promise<R>): Promise<R> {
      const tx = new Tx();
      const out = await fn(tx);
      await tx.commit();
      return out;
    },
  } as unknown as Firestore;
}

/** A snapshot of the document at `path` in `store`, as a trigger's event gives it. */
export function snapAt(store: Store, path: string): DocumentSnapshot {
  const data = store.get(path);
  return new Snap(
    new Ref(store, path),
    data && (copy(data) as Data),
  ) as unknown as DocumentSnapshot;
}
