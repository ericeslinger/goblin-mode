import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { GardenNote, RawProposal } from './proposals';

/** Organizing needs judgment across many notes; titles make do with less. */
export const ORGANIZE_MODEL = 'claude-sonnet-5-5';
/** What Claude sees: recent notes in full (to a point), the rest by name. */
export const RECENT_DAYS = 7;
const RECENT_NOTES = 30;
const BODY_CHARS = 1500;
const OTHER_NOTES = 300;
const CONCEPTS = 200;

/** Asks for suggestions about the garden; `recent` are the notes to look at. */
export type Proposer = (
  garden: readonly GardenNote[],
  recent: readonly GardenNote[],
) => Promise<RawProposal[]>;

const SYSTEM = [
  "You help organize a personal notes app, the gardener's garden of notes. Suggest a few " +
    'changes the gardener will accept or dismiss one by one:',
  '- link: one note should link to others about the same thing.',
  '- merge: several notes are fragments of one note; they will be joined whole, in your order.',
  '- refile: a concept should be a person or a project, or has other names the notes use.',
  'Look mostly at the recent notes. Suggest only what is clearly useful; suggesting nothing is ' +
    'fine. Never suggest rewording; the tools keep the text word for word. Use only the ids ' +
    'given. Each reason is one short sentence to the gardener.',
].join('\n');

const one = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The garden as Claude reads it. */
export function digest(garden: readonly GardenNote[], recent: readonly GardenNote[]): string {
  const live = garden.filter((n) => !n.archived);
  const concepts = live.filter((n) => n.kind === 'concept').slice(0, CONCEPTS);
  const shown = new Set(recent.map((n) => n.id));
  const others = live
    .filter((n) => n.kind !== 'concept' && !shown.has(n.id) && n.title.trim())
    .slice(0, OTHER_NOTES);
  return [
    'Concepts (id | name | type | other names):',
    ...concepts.map(
      (c) =>
        `${c.id} | ${one(c.title)} | ${c.conceptType ?? 'other'} | ${(c.synonyms ?? []).map(one).join(', ')}`,
    ),
    '',
    `Recent notes, changed in the last ${RECENT_DAYS} days:`,
    ...recent
      .slice(0, RECENT_NOTES)
      .map((n) => `<note id="${n.id}" kind="${n.kind}">\n${n.body.slice(0, BODY_CHARS)}\n</note>`),
    '',
    'Other notes (id | title):',
    ...others.map((n) => `${n.id} | ${one(n.title)}`),
  ].join('\n');
}

const Raw = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('link'),
    from: z.string(),
    to: z.array(z.string()),
    reason: z.string(),
  }),
  z.object({
    kind: z.literal('merge'),
    ids: z.array(z.string()),
    title: z.string().optional(),
    reason: z.string(),
  }),
  z.object({
    kind: z.literal('refile'),
    id: z.string(),
    type: z.enum(['person', 'project', 'other']).optional(),
    synonyms: z.array(z.string()).optional(),
    reason: z.string(),
  }),
]);

/** Claude's answer, keeping each suggestion that has the right shape. */
export function parseAnswer(input: unknown): RawProposal[] {
  const list = (input as { proposals?: unknown } | undefined)?.proposals;
  if (!Array.isArray(list)) return [];
  return list.flatMap((p) => {
    const r = Raw.safeParse(p);
    return r.success ? [r.data] : [];
  });
}

const TOOL: Anthropic.Tool = {
  name: 'propose',
  description: 'Hand the gardener your suggestions.',
  input_schema: {
    type: 'object',
    properties: {
      proposals: {
        type: 'array',
        maxItems: 15,
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['link', 'merge', 'refile'] },
            reason: { type: 'string' },
            from: { type: 'string', description: 'link: the note to add links to' },
            to: { type: 'array', items: { type: 'string' }, description: 'link: notes to link' },
            ids: { type: 'array', items: { type: 'string' }, description: 'merge: in order' },
            title: { type: 'string', description: 'merge: optional title' },
            id: { type: 'string', description: 'refile: the concept' },
            type: { type: 'string', enum: ['person', 'project', 'other'] },
            synonyms: { type: 'array', items: { type: 'string' } },
          },
          required: ['kind', 'reason'],
        },
      },
    },
    required: ['proposals'],
  },
};

/** Suggestions from Claude, through the federated client. */
export function claudeProposer(client: Pick<Anthropic, 'messages'>): Proposer {
  return async (garden, recent) => {
    const message = await client.messages.create({
      model: ORGANIZE_MODEL,
      max_tokens: 4096,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: 'propose' },
      messages: [{ role: 'user', content: digest(garden, recent) }],
    });
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.name === 'propose') return parseAnswer(block.input);
    }
    return [];
  };
}
