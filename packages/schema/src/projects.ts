// Projects (#41): concepts of type project, with a parent, a kind and a
// status, whose own text holds the sections of the project page.

/** A project page's sections, in order (Eric, 2026-10-08). */
export const PROJECT_SECTIONS = [
  'Overview',
  'Working notes',
  'Tasks',
  'Ideas',
  'Open questions',
  'Decisions',
  'Links',
] as const;

const heading = (name: string) => new RegExp(`^##\\s+${name}\\s*$`, 'im');

/**
 * `body` with every project section heading: text already there stays,
 * word for word, under Overview when it has no sections of its own.
 * Otherwise each missing heading goes in its place, before the next
 * section that is there, or at the end (review on #95). Unchanged when
 * all are present.
 */
export function withProjectSections(body: string): string {
  const missing = PROJECT_SECTIONS.filter((s) => !heading(s).test(body));
  if (missing.length === 0) return body;
  if (missing.length === PROJECT_SECTIONS.length) {
    const text = body.trim();
    const parts = ['## Overview', ...(text ? ['', text] : [])];
    for (const s of missing.slice(1)) parts.push('', `## ${s}`);
    return `${parts.join('\n')}\n`;
  }
  let out = body;
  for (const s of missing) {
    const later = PROJECT_SECTIONS.slice(PROJECT_SECTIONS.indexOf(s) + 1)
      .map((n) => heading(n).exec(out))
      .find((m) => m !== null);
    out = later
      ? `${out.slice(0, later.index)}## ${s}\n\n${out.slice(later.index)}`
      : `${out.replace(/\s*$/, '')}\n\n## ${s}\n`;
  }
  return out;
}

interface Parented {
  id: string;
  parent?: string;
  archived?: boolean;
}

/** The live projects whose parent is `id`. */
export function childrenOf<T extends Parented>(id: string, projects: readonly T[]): T[] {
  return projects.filter((p) => p.parent === id && !p.archived);
}

/** `id` and every project under it, however deep (a guard against cycles). */
export function selfAndDescendants(id: string, projects: readonly Parented[]): Set<string> {
  const found = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of projects) {
      if (p.parent && found.has(p.parent) && !found.has(p.id)) {
        found.add(p.id);
        grew = true;
      }
    }
  }
  return found;
}

/** Whether `parent` may be `id`'s parent: not itself, nor anything under it. */
export function canParent(id: string, parent: string, projects: readonly Parented[]): boolean {
  return !selfAndDescendants(id, projects).has(parent);
}
