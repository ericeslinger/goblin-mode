// Lists in notes (#39): checklist items grouped under their headings,
// ticked one line at a time, and cleared after shopping. Every change
// touches only the lines it is about, so it merges cleanly with Claude's
// line edits and another device's (#37).

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const TASK = /^(\s*[-*+]\s+\[)([ xX])(\](?:\s+|$))(.*)$/;

/** A staple comes back on the next list after Done shopping. */
export const STAPLE = '★';

export interface ChecklistItem {
  /** The item's line in the body, from 0. */
  line: number;
  text: string;
  done: boolean;
  staple: boolean;
}

export interface ChecklistSection {
  /** The heading above the items; '' for items before any heading. */
  heading: string;
  items: ChecklistItem[];
}

/** The checklist items of a body, under their headings, in order. */
export function checklist(body: string): ChecklistSection[] {
  const sections: ChecklistSection[] = [{ heading: '', items: [] }];
  body.split('\n').forEach((l, line) => {
    const heading = HEADING.exec(l);
    if (heading) {
      sections.push({ heading: heading[2], items: [] });
      return;
    }
    const task = TASK.exec(l);
    if (task) {
      sections[sections.length - 1].items.push({
        line,
        text: task[4],
        done: task[2] !== ' ',
        staple: task[4].includes(STAPLE),
      });
    }
  });
  return sections.filter((s) => s.items.length > 0);
}

/** Ticks or unticks the item on `line`; any other line is left alone. */
export function setDone(body: string, line: number, done: boolean): string {
  const lines = body.split('\n');
  if (!TASK.test(lines[line] ?? '')) return body;
  lines[line] = lines[line].replace(
    TASK,
    (_, open, _mark, close, text) => `${open}${done ? 'x' : ' '}${close}${text}`,
  );
  return lines.join('\n');
}

/**
 * After shopping: ticked items go, except staples, which are unticked
 * so they come back on the next list. Nothing else changes.
 */
export function doneShopping(body: string): string {
  const out: string[] = [];
  for (const l of body.split('\n')) {
    const task = TASK.exec(l);
    if (!task || task[2] === ' ') {
      out.push(l);
    } else if (task[4].includes(STAPLE)) {
      out.push(`${task[1]} ${task[3]}${task[4]}`);
    }
  }
  return out.join('\n');
}
