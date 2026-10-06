// Read-only HTML for a note: previews, search results, anywhere that is
// not the editor. Raw HTML in a note is never passed through, and the
// output is sanitized, so a note cannot inject script or styles.
import type { Element, ElementContent } from 'hast';
import type { Image } from 'mdast';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { ATTACHMENT_SCHEME } from './extract';
import { parseNote } from './parse';
import type { WikiLink } from './wikilink';

export interface RenderOptions {
  /**
   * Turns an attachment id into an image URL. Without it (or when it
   * returns undefined), attachment images render as their caption.
   */
  resolveAttachment?: (id: string) => string | undefined;
}

const schema = {
  ...defaultSchema,
  protocols: { ...defaultSchema.protocols, src: ['http', 'https', 'blob'] },
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.['span'] ?? []), 'className', 'dataTarget'],
  },
};

function wikiLinkElement(node: WikiLink): Element {
  return {
    type: 'element',
    tagName: 'span',
    properties: { className: ['wikilink'], dataTarget: node.target },
    children: [{ type: 'text', value: node.alias ?? node.target }],
  };
}

function imageElement(node: Image, options: RenderOptions): ElementContent {
  if (node.url.startsWith(ATTACHMENT_SCHEME)) {
    const src = options.resolveAttachment?.(node.url.slice(ATTACHMENT_SCHEME.length));
    if (!src) {
      return {
        type: 'element',
        tagName: 'span',
        properties: { className: ['attachment-placeholder'] },
        children: [{ type: 'text', value: node.alt || 'image' }],
      };
    }
    return {
      type: 'element',
      tagName: 'img',
      properties: { src, alt: node.alt ?? '' },
      children: [],
    };
  }
  return {
    type: 'element',
    tagName: 'img',
    properties: { src: node.url, alt: node.alt ?? '' },
    children: [],
  };
}

/** Renders a note body to sanitized HTML. */
export function renderNoteHtml(text: string, options: RenderOptions = {}): string {
  const tree = parseNote(text);
  const html = unified()
    .use(remarkRehype, {
      handlers: {
        wikiLink: (_state, node: WikiLink) => wikiLinkElement(node),
        image: (_state, node: Image) => imageElement(node, options),
      },
    })
    .use(rehypeSanitize, schema)
    .use(rehypeStringify);
  return html.stringify(html.runSync(tree));
}
