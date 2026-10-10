// The one markdown grammar: CommonMark, GFM (task lists, tables,
// strikethrough, autolinks) and wiki links, with Eric's emphasis
// (`*bold*`, `_italic_`; see emphasis.ts). Everything that needs to
// understand a note goes through parseNote; see DESIGN.md, Editor.
import type { Root } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { VFile } from 'vfile';
import { remarkSingleStarStrong } from './emphasis';
import { remarkWikiLinks } from './wikilink';

const processor = unified()
  // No setext headings: a lone `-` under a line is a list item being
  // typed, not an underline making the line a heading (#118). Headings
  // are `#` lines, as the ribbon writes them.
  .data('micromarkExtensions', [{ disable: { null: ['setextUnderline'] } }])
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkSingleStarStrong)
  .use(remarkWikiLinks);

/** Parses a note body into mdast, with source positions on every node. */
export function parseNote(text: string): Root {
  const file = new VFile(text);
  return processor.runSync(processor.parse(file), file);
}
