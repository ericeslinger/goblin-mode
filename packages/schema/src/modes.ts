// Document modes (#231, step 3 of #155, 2026-11-09): how a note takes
// new material. Each is a preset over the note's Instructions for
// Claude: words the assistant reads before writing, joined with the
// note's own instructions by `modeBrief`. Only a Log changes what a
// tool does (add_lines dates its lines); the others guide in words.
import { NoteMode } from './model';
import { templateParts } from './templates';

export interface ModeInfo {
  /** What the back's select says. */
  label: string;
  /** One line under the select, for Eric. */
  hint: string;
  /** What the assistant reads (get_note's `takes`). */
  preset: string;
}

export const MODES: Record<NoteMode, ModeInfo> = {
  list: {
    label: 'List',
    hint: 'One item per line; Claude adds what is missing and never drops an unticked item.',
    preset:
      'Put each new item on its own line under the section it belongs in. Add only ' +
      'what is missing, never a duplicate, even one in other words. Never drop or reword an ' +
      'unticked item; a ticked one may be left as it is.',
  },
  log: {
    label: 'Log',
    hint: 'Claude adds under today’s date, newest last, in the author’s voice.',
    preset:
      'Append new material under a heading for today’s date, newest last (add_lines ' +
      'does this for you). Keep the author’s voice and tense. Never rewrite earlier entries.',
  },
  synthesis: {
    label: 'Synthesis',
    hint: 'Claude weaves new material into the outline and says where it contradicts.',
    preset:
      'Weave new material into the outline where it belongs. Where it ' +
      'contradicts what is there, keep both and say which is newer. Eric’s sentences stay ' +
      'verbatim wherever they survive, and nothing is dropped without a line saying so.',
  },
};

/** The modes in the back's order. */
export const MODE_IDS: readonly NoteMode[] = NoteMode.options;

/**
 * The kinds that carry a mode and Instructions for Claude: plain text,
 * concepts, templates and clippings. Not sketches, recipes, meal plans,
 * the pantry or the context note, which have their own ways.
 */
export function takesInstructions(kind: string | undefined): boolean {
  return ['text', 'concept', 'template', 'clipping'].includes(kind ?? 'text');
}

/** The fields `effectiveMode` reads, as the app and the server hold them. */
export interface Instructed {
  id?: string;
  kind?: string;
  body?: string;
  mode?: string;
  instructions?: string;
  templateMode?: string;
  fromTemplate?: string;
}

/** How a note takes new material, and whether any of it is its template's. */
export interface Takes {
  mode?: NoteMode;
  instructions: string;
  /** The mode or the instructions are the living note's template's. */
  inherited: boolean;
}

function own(note: Instructed): { mode?: NoteMode; instructions: string } {
  const mode = NoteMode.safeParse(note.mode);
  const instructions =
    note.kind === 'template'
      ? templateParts(note.body ?? '', note.instructions).instructions
      : (note.instructions ?? '').trim();
  return { ...(mode.success ? { mode: mode.data } : {}), instructions };
}

/**
 * How `note` takes new material: its own mode and instructions, each
 * falling back to its template's when the note is that living
 * template's note and sets none of its own. `template` is the note's
 * `fromTemplate`, if the caller has it. Undefined when nothing applies
 * or the kind carries none.
 */
export function effectiveMode(note: Instructed, template?: Instructed): Takes | undefined {
  if (!takesInstructions(note.kind)) return undefined;
  const mine = own(note);
  const living =
    note.kind !== 'template' &&
    template !== undefined &&
    template.kind === 'template' &&
    template.templateMode === 'living' &&
    note.fromTemplate !== undefined &&
    template.id === note.fromTemplate
      ? own(template)
      : { instructions: '' };
  const mode = mine.mode ?? living.mode;
  const instructions = mine.instructions || living.instructions;
  if (!mode && !instructions) return undefined;
  const inherited = (!mine.mode && !!living.mode) || (!mine.instructions && !!living.instructions);
  return { ...(mode ? { mode } : {}), instructions, inherited };
}

/**
 * What the assistant reads before adding to the note: the mode's preset
 * and the note's own instructions, the preset first.
 */
export function modeBrief(mode: NoteMode | undefined, instructions: string | undefined): string {
  const words = (instructions ?? '').trim();
  return [
    mode ? `Takes new material as a ${MODES[mode].label.toLowerCase()}: ${MODES[mode].preset}` : '',
    words ? `Instructions for Claude: ${words}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
