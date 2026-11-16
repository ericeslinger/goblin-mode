// Finding tags in HTML in one pass (review on reader mode, 2026-11-16).
// It reads exactly what this regex did, which visibleHtml and the
// reader's tag tree used:
//
//   /<(\/?)([a-z][a-z0-9-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/gi
//
// but the regex looked ahead to the end of the page from every `<` that
// never closed (`<a <a <a ...`, `<a "`), so a hostile page took time in
// the square of its length. Here where a tag ends, from any point, is
// worked out once, backwards over the page, and each `<` is then read
// in time of its name alone. Comments and `<!...>` declarations are
// found too when asked, in the same way.

export interface Tag {
  kind: 'tag' | 'comment' | 'declaration';
  /** Where the token begins (its `<`) and ends (after its `>`). */
  start: number;
  end: number;
  close: boolean;
  /** The name as written; '' for a comment or declaration. */
  name: string;
  /** What lies between the name and the end, a self-closing slash not included. */
  attrs: string;
  selfClose: boolean;
}

const isWord = (c: number) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isNameChar = (c: number) => isLetter(c) || (c >= 48 && c <= 57) || c === 45;

const GT = 62;
const DQ = 34;
const SQ = 39;

/** A reader of `html`'s tags: `next(from)` is the first token at or after `from`. */
export function tagScanner(html: string, options: { comments?: boolean } = {}) {
  const n = html.length;
  let ends: Int32Array | undefined;
  // From any point outside quotes, where the first `>` outside quotes
  // is, or -1 when a quote never closes or no `>` comes: one backward
  // pass, only when first needed.
  const endFrom = (i: number): number => {
    if (!ends) {
      ends = new Int32Array(n + 1);
      ends[n] = -1;
      let nextDq = -1;
      let nextSq = -1;
      for (let k = n - 1; k >= 0; k--) {
        const c = html.charCodeAt(k);
        if (c === GT) ends[k] = k;
        else if (c === DQ) ends[k] = nextDq < 0 ? -1 : ends[nextDq + 1];
        else if (c === SQ) ends[k] = nextSq < 0 ? -1 : ends[nextSq + 1];
        else ends[k] = ends[k + 1];
        if (c === DQ) nextDq = k;
        else if (c === SQ) nextSq = k;
      }
    }
    return ends[i];
  };
  // The first `>` at or after a point, remembered so a run of `<!` with
  // none to come is not searched again each time.
  let gtFrom = -1;
  let gtAt = -1;
  const nextGt = (from: number) => {
    if (gtFrom < 0 || from < gtFrom || (gtAt >= 0 && gtAt < from)) {
      gtFrom = from;
      gtAt = html.indexOf('>', from);
    }
    return gtAt;
  };
  let commentsDone = false;

  const at = (s: number): Tag | undefined => {
    let i = s + 1;
    const close = html.charCodeAt(i) === 47;
    if (close) i++;
    if (isLetter(html.charCodeAt(i))) {
      let k = i + 1;
      while (k < n && isNameChar(html.charCodeAt(k))) k++;
      // The name ends at a word boundary, as `\b` asks, giving back
      // characters as the regex would.
      const boundary = (p: number) =>
        isWord(html.charCodeAt(p - 1)) !== (p < n && isWord(html.charCodeAt(p)));
      while (k > i + 1 && !boundary(k)) k--;
      if (boundary(k)) {
        const e = endFrom(k);
        if (e >= 0) {
          const selfClose = e - 1 >= k && html.charCodeAt(e - 1) === 47;
          return {
            kind: 'tag',
            start: s,
            end: e + 1,
            close,
            name: html.slice(i, k),
            attrs: html.slice(k, selfClose ? e - 1 : e),
            selfClose,
          };
        }
      }
    }
    if (!options.comments || close || html.charCodeAt(s + 1) !== 33) return undefined;
    if (html.startsWith('<!--', s)) {
      // A comment never closed runs to the end, once.
      const c = commentsDone ? -1 : html.indexOf('-->', s + 4);
      if (c < 0) commentsDone = true;
      return comment('comment', s, c < 0 ? n : c + 3);
    }
    const g = nextGt(s + 2);
    return g < 0 ? undefined : comment('declaration', s, g + 1);
  };
  const comment = (kind: Tag['kind'], start: number, end: number): Tag => ({
    kind,
    start,
    end,
    close: false,
    name: '',
    attrs: '',
    selfClose: false,
  });

  return {
    next(from: number): Tag | undefined {
      for (let s = html.indexOf('<', from); s >= 0; s = html.indexOf('<', s + 1)) {
        const t = at(s);
        if (t) return t;
      }
      return undefined;
    },
  };
}

/** Every tag in `html` in order, as the regex above found them. */
export function* tagsOf(html: string, options: { comments?: boolean } = {}): Generator<Tag> {
  const scan = tagScanner(html, options);
  for (let t = scan.next(0); t; t = scan.next(t.end)) yield t;
}

/**
 * `html` with every `<` that starts no tag, comment or declaration
 * written as `&lt;`: it reads as the same words, and no later pattern
 * that runs from a `<` to the next `>` can cross the page from it.
 */
export function escapeStrayLt(html: string): string {
  const scan = tagScanner(html, { comments: true });
  let out = '';
  let at = 0;
  for (let s = html.indexOf('<'); s >= 0;) {
    const t = scan.next(s);
    const next = t ? t.start : -1;
    // Every `<` before the next token starts none.
    const stop = next < 0 ? html.length : next;
    for (let k = s; k >= 0 && k < stop; k = html.indexOf('<', k + 1)) {
      out += html.slice(at, k) + '&lt;';
      at = k + 1;
    }
    if (!t) break;
    s = html.indexOf('<', t.end);
  }
  return out + html.slice(at);
}
