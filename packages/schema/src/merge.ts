// Three-way merge of note text by lines (#37): when a note changes on
// the server while it is being typed in, the open editor keeps both
// sides instead of either one winning.

/** The most cells a merge's line table may have (lines changed x lines changed). */
export const MAX_TABLE = 2_000_000;

/** For each line of `a`, the index of the line it matches in `b`, or -1 (an LCS). */
function matches(a: readonly string[], b: readonly string[]): number[] {
  const n = a.length;
  const m = b.length;
  // Lines both sides start and end with need no table.
  let start = 0;
  while (start < n && start < m && a[start] === b[start]) start++;
  let endA = n;
  let endB = m;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out = new Array<number>(n).fill(-1);
  for (let i = 0; i < start; i++) out[i] = i;
  for (let i = endA; i < n; i++) out[i] = endB + (i - endA);
  const rows = endA - start;
  const cols = endB - start;
  // A huge rewrite matches only its shared ends: the middle is kept from
  // both sides, which is safe, instead of a table too big for a phone.
  if (rows === 0 || cols === 0 || rows * cols > MAX_TABLE) return out;
  // Lengths of common subsequences of the middles, from the end.
  const len: Uint32Array[] = Array.from({ length: rows + 1 }, () => new Uint32Array(cols + 1));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      len[i][j] =
        a[start + i] === b[start + j]
          ? len[i + 1][j + 1] + 1
          : Math.max(len[i + 1][j], len[i][j + 1]);
    }
  }
  for (let i = 0, j = 0; i < rows && j < cols;) {
    if (a[start + i] === b[start + j]) {
      out[start + i] = start + j;
      i++;
      j++;
    } else if (len[i + 1][j] >= len[i][j + 1]) i++;
    else j++;
  }
  return out;
}

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((line, i) => line === b[i]);

/** Where each line of `sub` sits in `seq`, in order, or undefined if it does not. */
function positions(sub: readonly string[], seq: readonly string[]): number[] | undefined {
  const at: number[] = [];
  let j = 0;
  for (const line of sub) {
    while (j < seq.length && seq[j] !== line) j++;
    if (j === seq.length) return undefined;
    at.push(j++);
  }
  return at;
}

/** The lines of `lines` beyond those `have` already holds, counted, in order. */
function unshared(lines: readonly string[], have: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const line of have) left.set(line, (left.get(line) ?? 0) + 1);
  return lines.filter((line) => {
    const n = left.get(line) ?? 0;
    if (n > 0) left.set(line, n - 1);
    return n === 0;
  });
}

/**
 * One side only added lines around a stretch the other side changed:
 * its additions go before, between and after the other side's version.
 */
function weave(base: readonly string[], added: readonly string[], changed: readonly string[]) {
  const at = positions(base, added);
  if (!at || base.length === 0) return undefined;
  const first = at[0];
  const last = at[at.length - 1];
  const between = added.slice(first, last + 1).filter((_, i) => !at.includes(first + i));
  return [...added.slice(0, first), ...changed, ...between, ...added.slice(last + 1)];
}

/**
 * Merges `ours` and `theirs`, both changed from `base`. Where only one
 * side changed a stretch, that change is taken; where both made the same
 * change, it is taken once; where one side only added lines around a
 * stretch the other changed, both are kept in place (a tick beside a new
 * item); otherwise both are kept, ours first and then the lines of
 * theirs that ours does not already have. Nothing either side wrote is
 * dropped.
 */
export function merge3(base: string, ours: string, theirs: string): string {
  if (ours === theirs || theirs === base) return ours;
  if (ours === base) return theirs;
  const b = base.split('\n');
  const o = ours.split('\n');
  const t = theirs.split('\n');
  const toOurs = matches(b, o);
  const toTheirs = matches(b, t);
  const out: string[] = [];
  let pb = -1;
  let po = -1;
  let pt = -1;
  const take = (bi: number, oi: number, ti: number) => {
    const bc = b.slice(pb + 1, bi);
    const oc = o.slice(po + 1, oi);
    const tc = t.slice(pt + 1, ti);
    if (same(oc, bc)) out.push(...tc);
    else if (same(tc, bc) || same(oc, tc)) out.push(...oc);
    else out.push(...(weave(bc, tc, oc) ?? weave(bc, oc, tc) ?? [...oc, ...unshared(tc, oc)]));
  };
  for (let i = 0; i < b.length; i++) {
    // A line both sides kept anchors the stretches around it.
    if (toOurs[i] < 0 || toTheirs[i] < 0 || toOurs[i] <= po || toTheirs[i] <= pt) continue;
    take(i, toOurs[i], toTheirs[i]);
    out.push(b[i]);
    pb = i;
    po = toOurs[i];
    pt = toTheirs[i];
  }
  take(b.length, o.length, t.length);
  return out.join('\n');
}

/**
 * A short fingerprint of a text, stored with a note write as the text
 * it was based on (`baseHash`), so a write based on an older text can
 * be told and merged (#37). Not for security.
 */
export function textHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${text.length.toString(36)}-${h.toString(16).padStart(8, '0')}`;
}
