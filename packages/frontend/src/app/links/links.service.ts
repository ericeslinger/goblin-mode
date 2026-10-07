import { Injectable, computed, inject } from '@angular/core';
import { findWikiLinks, parseNote, wikiLinkTargets } from '@mossgoblin/editor/grammar';
import {
  CONCEPT_PREFIX,
  backlinks,
  normalizeName,
  oftenTogether,
  resolveLinks,
  sentenceAround,
} from '@mossgoblin/schema';
import { NotesService, type NoteRecord } from '../notes/notes.service';

/** A note that links here, and the sentence it does it in. */
export interface Backlink {
  id: string;
  title: string;
  sentence: string;
}

interface Parsed {
  body: string;
  /** Link targets the grammar finds (so none inside code). */
  targets: string[];
  /** Where each `[[...]]` sits in the body. */
  spans: { start: number; end: number; target: string }[];
}

/**
 * The link graph, from note bodies resolved against today's names
 * (DESIGN.md, Links and concepts): stored `links` can be stale or empty
 * for older notes, so they are not read here. Each body is parsed once
 * per change.
 */
@Injectable({ providedIn: 'root' })
export class LinksService {
  private readonly notes = inject(NotesService);
  private readonly parsed = new Map<string, Parsed>();

  /** Every note with the ids its body links to now. */
  readonly graph = computed(() => {
    const names = this.notes.names();
    const live = new Set<string>();
    const graph = this.notes.notes().map((n) => {
      live.add(n.id);
      return { ...n, links: resolveLinks(this.parse(n).targets, names) };
    });
    for (const id of this.parsed.keys()) if (!live.has(id)) this.parsed.delete(id);
    return graph;
  });

  /** Notes that link to `id`, newest first, each with its sentence. */
  backlinksTo(id: string): Backlink[] {
    const names = this.notes.names();
    return backlinks(id, this.graph()).map((n) => {
      const span = this.parse(n).spans.find((s) => resolveLinks([s.target], names)[0] === id);
      return {
        id: n.id,
        title: n.title || 'Untitled',
        sentence: span ? sentenceAround(n.body, span.start, span.end) : '',
      };
    });
  }

  /** Concepts that share notes with `id`, most shared first. */
  togetherWith(id: string): { id: string; title: string }[] {
    const byId = new Map(this.notes.notes().map((n) => [n.id, n]));
    const isConcept = (other: string) =>
      other.startsWith(CONCEPT_PREFIX) || byId.get(other)?.kind === 'concept';
    return oftenTogether(id, this.graph(), 6, isConcept).map(({ id: other }) => ({
      id: other,
      title: byId.get(other)?.title ?? other,
    }));
  }

  private parse(note: NoteRecord): Parsed {
    const known = this.parsed.get(note.id);
    if (known?.body === note.body) return known;
    const targets = wikiLinkTargets(parseNote(note.body));
    const real = new Set(targets.map(normalizeName));
    const spans = findWikiLinks(note.body)
      .filter((s) => real.has(normalizeName(s.target)))
      .map(({ start, end, target }) => ({ start, end, target }));
    const parsed = { body: note.body, targets, spans };
    this.parsed.set(note.id, parsed);
    return parsed;
  }
}
