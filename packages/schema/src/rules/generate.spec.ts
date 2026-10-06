import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BEGIN, END, generatedBlock, spliceGenerated, validatorFor } from './generate';
import { renderRulesBlock } from './registry';

const Stamp = z.custom<{ seconds: number }>(() => true);

describe('validatorFor', () => {
  it('checks required keys, no extra keys, and each field type', () => {
    const fn = validatorFor(
      {
        name: 'Thing',
        schema: z.object({
          title: z.string(),
          done: z.boolean(),
          count: z.number(),
          tags: z.array(z.string()),
          kind: z.enum(['a', 'b']),
          at: Stamp,
          note: z.string().optional(),
          extra: z.object({ x: z.string() }).optional(),
        }),
      },
      Stamp,
    );
    expect(fn).toBe(
      [
        'function isValidThing(data) {',
        "  return data.keys().hasAll(['title', 'done', 'count', 'tags', 'kind', 'at'])",
        "    && data.keys().hasOnly(['title', 'done', 'count', 'tags', 'kind', 'at', 'note', 'extra'])",
        '    && data.title is string',
        '    && data.done is bool',
        '    && data.count is number',
        '    && data.tags is list',
        "    && (data.kind is string && data.kind in ['a', 'b'])",
        '    && data.at is timestamp',
        "    && (!('note' in data) || data.note is string)",
        "    && (!('extra' in data) || data.extra is map);",
        '}',
      ].join('\n'),
    );
  });

  it('warns and fails closed on a type it cannot map', () => {
    const warnings: string[] = [];
    const fn = validatorFor(
      { name: 'X', schema: z.object({ u: z.union([z.string(), z.number()]) }) },
      Stamp,
      (w) => warnings.push(w),
    );
    expect(fn).toContain('&& false');
    expect(warnings).toEqual(["no rules mapping for zod type 'union' at data.u"]);
  });
});

describe('spliceGenerated', () => {
  it('replaces only the marked block', () => {
    const rules = `a\n    ${BEGIN}\n    old\n    ${END}\nb`;
    const block = generatedBlock([{ name: 'Y', schema: z.object({ s: z.string() }) }], Stamp);
    const out = spliceGenerated(rules, block);
    expect(out.startsWith('a\n    ' + BEGIN)).toBe(true);
    expect(out.endsWith(END + '\nb')).toBe(true);
    expect(out).toContain('function isValidY(data)');
    expect(out).not.toContain('old');
  });

  it('throws when the markers are gone', () => {
    expect(() => spliceGenerated('no markers', 'x')).toThrow(/markers/);
  });
});

describe('renderRulesBlock', () => {
  it('maps every field of the client-written collections', () => {
    const { block, warnings } = renderRulesBlock();
    expect(warnings).toEqual([]);
    expect(block).toContain('function isValidNote(data)');
    expect(block).toContain('function isValidReminder(data)');
    expect(block).toContain('function isValidDevice(data)');
    expect(block).toContain('data.updatedAt is timestamp');
  });
});
