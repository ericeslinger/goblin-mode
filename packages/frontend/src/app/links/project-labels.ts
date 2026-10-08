import type { ProjectKind, ProjectStatus } from '@mossgoblin/schema';

/** A project's kinds and statuses as the app names them (#41). */
export const KINDS: { id: ProjectKind; label: string }[] = [
  { id: 'build', label: 'Build' },
  { id: 'content', label: 'Content' },
];

/** The six statuses, in Eric's words (2026-10-08). */
export const STATUSES: { id: ProjectStatus; label: string }[] = [
  { id: 'new', label: 'New' },
  { id: 'active', label: 'Active' },
  { id: 'nearly-done', label: 'Nearly done' },
  { id: 'maintenance', label: 'Maintenance' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'done', label: 'Done' },
];

export const kindLabel = (k?: string) => KINDS.find((x) => x.id === k)?.label ?? '';
export const statusLabel = (s?: string) => STATUSES.find((x) => x.id === s)?.label ?? '';
