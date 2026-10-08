// Facts about a note that other parts of the app need without rendering
// it: what it links to, which tasks it holds, which attachments it uses.
import type { ListItem, Root } from 'mdast';
import { toString } from 'mdast-util-to-string';
import { visit } from 'unist-util-visit';
import type { WikiLink } from './wikilink';

export const ATTACHMENT_SCHEME = 'attachment:';

/** Distinct wiki link targets, in order of first appearance. */
export function wikiLinkTargets(root: Root): string[] {
  const seen = new Set<string>();
  visit(root, 'wikiLink', (node: WikiLink) => {
    seen.add(node.target);
  });
  return [...seen];
}

export interface Task {
  text: string;
  done: boolean;
  /** 1-based line of the task in the note. */
  line: number;
}

/** GFM task list items (`- [ ] x`, `- [x] y`). */
export function tasks(root: Root): Task[] {
  const found: Task[] = [];
  visit(root, 'listItem', (node: ListItem) => {
    if (node.checked === null || node.checked === undefined) return;
    found.push({
      text: toString(node.children[0] ?? node).trim(),
      done: node.checked,
      line: node.position?.start.line ?? 0,
    });
  });
  return found;
}

/**
 * Ids from `![caption](attachment:<id>)` images and `[name](attachment:<id>)`
 * files (#45), in order.
 */
export function attachmentIds(root: Root): string[] {
  const ids: string[] = [];
  visit(root, (node) => {
    if ((node.type === 'image' || node.type === 'link') && node.url.startsWith(ATTACHMENT_SCHEME)) {
      ids.push(node.url.slice(ATTACHMENT_SCHEME.length));
    }
  });
  return ids;
}
