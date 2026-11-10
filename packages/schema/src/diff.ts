// The line diff the diff view shows (#241, step 5 of #154): what a run
// kept, added and removed in a note's text. Pure; an LCS on lines,
// after the lines both texts share at the start and the end.

export type DiffKind = 'kept' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

export interface LineDiff {
  lines: DiffLine[];
  /**
   * The changed middle was too long to compare line by line: it is
   * given whole, every line before it removed, then every line after
   * it added.
   */
  capped: boolean;
}

/** The most cells the LCS table may have; note-sized texts are far below. */
export const MAX_DIFF_CELLS = 1_000_000;

/** A text's lines; an empty text has none. */
export function textLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

/**
 * The lines of `after` against `before`, in order: kept where both have
 * them, removed where only `before` has, added where only `after` has,
 * removals of a changed stretch before its additions, so a changed
 * line reads as removed then added. `maxCells` caps the work.
 */
export function lineDiff(before: string, after: string, maxCells = MAX_DIFF_CELLS): LineDiff {
  const a = textLines(before);
  const b = textLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a.slice(0, start).map((text): DiffLine => ({ kind: 'kept', text }));
  const tail = a.slice(endA).map((text): DiffLine => ({ kind: 'kept', text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const removed = (text: string): DiffLine => ({ kind: 'removed', text });
  const added = (text: string): DiffLine => ({ kind: 'added', text });
  if (midA.length === 0 || midB.length === 0) {
    return { lines: [...head, ...midA.map(removed), ...midB.map(added), ...tail], capped: false };
  }
  const rows = midA.length;
  const cols = midB.length;
  if (rows * cols > maxCells) {
    return { lines: [...head, ...midA.map(removed), ...midB.map(added), ...tail], capped: true };
  }
  // len[i][j]: the longest common run of midA[i..] and midB[j..].
  const width = cols + 1;
  const len = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      len[i * width + j] =
        midA[i] === midB[j]
          ? len[(i + 1) * width + j + 1] + 1
          : Math.max(len[(i + 1) * width + j], len[i * width + j + 1]);
    }
  }
  const mid: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (midA[i] === midB[j]) {
      mid.push({ kind: 'kept', text: midA[i] });
      i++;
      j++;
    } else if (len[(i + 1) * width + j] >= len[i * width + j + 1]) {
      mid.push(removed(midA[i++]));
    } else {
      mid.push(added(midB[j++]));
    }
  }
  while (i < rows) mid.push(removed(midA[i++]));
  while (j < cols) mid.push(added(midB[j++]));
  return { lines: [...head, ...mid, ...tail], capped: false };
}
