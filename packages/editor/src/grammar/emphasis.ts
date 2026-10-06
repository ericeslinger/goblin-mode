// Eric's emphasis (2026-10-06): `*text*` is bold, `_text_` is italic,
// and `**text**` stays bold. CommonMark parses a single `*` as emphasis,
// so this mdast transform turns emphasis written with one `*` into
// strong. The text is never changed, only what it means, so the editor,
// the HTML renderer and anything else reading the grammar agree.
import type { Emphasis, Root, Strong } from 'mdast';
import type { Plugin } from 'unified';
import { visit } from 'unist-util-visit';

/** The remark plugin. `source` is needed to see which delimiter was used. */
export const remarkSingleStarStrong: Plugin<[], Root> = function () {
  return (tree, file) => {
    const source = String(file.value ?? '');
    visit(tree, 'emphasis', (node: Emphasis) => {
      const from = node.position?.start.offset;
      const first = node.children[0]?.position?.start.offset;
      if (from === undefined || source[from] !== '*') return;
      // One delimiter character: the content starts right after it.
      if (first !== undefined && first !== from + 1) return;
      (node as unknown as Strong).type = 'strong';
    });
  };
};
