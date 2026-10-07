// Templates (#36): a template is a note whose body is a skeleton plus an
// "Instructions for Claude" section, so any Claude session knows how to
// run it without being told. The section is a heading in the body, edited
// like any note; these helpers find it.

/** The heading that starts a template's instructions, any level. */
const INSTRUCTIONS = /^(#{1,6})[ \t]+Instructions for Claude[ \t]*#*[ \t]*$/im;

/** A template's body split: what a new note starts from, and how to run it. */
export interface TemplateParts {
  /** The body without the instructions section. */
  skeleton: string;
  /** The section's text, without its heading; empty when there is none. */
  instructions: string;
}

/**
 * Splits a template's body. The instructions run from their heading to
 * the next heading of the same level or higher, or to the end.
 */
export function templateParts(body: string): TemplateParts {
  const m = INSTRUCTIONS.exec(body);
  if (!m) return { skeleton: body.trim(), instructions: '' };
  const level = m[1].length;
  const start = m.index;
  const after = start + m[0].length;
  const next = new RegExp(`^#{1,${level}}[ \\t]+\\S`, 'm').exec(body.slice(after));
  const end = next ? after + next.index : body.length;
  return {
    skeleton: `${body.slice(0, start).trimEnd()}\n\n${body.slice(end).trimStart()}`.trim(),
    instructions: body.slice(after, end).trim(),
  };
}
