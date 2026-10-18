// Templates (#36): a template is a note whose body is a skeleton, with
// instructions for Claude, so any Claude session knows how to run it
// without being told. The instructions were a section in the body; since
// #111 (2026-10-17) they are the template's `instructions` field, and a
// body that still has the section is read as before until it is moved.

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
 * Splits a template into the text a new note starts from and its
 * instructions: the `instructions` field when it has one (#111), else
 * the body's section, which runs from its heading to the next heading
 * of the same level or higher, or to the end.
 */
export function templateParts(body: string, field?: string): TemplateParts {
  const parts = sectionParts(body);
  // The field wins once there is one (#111); the section is the old place.
  return field === undefined ? parts : { skeleton: parts.skeleton, instructions: field.trim() };
}

/** The body split at its "Instructions for Claude" section, if it has one. */
function sectionParts(body: string): TemplateParts {
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
