// Draws a PDF's pages (#45). Imported only when a PDF is opened, so
// pdf.js stays out of the app's first load. Its worker is bundled by
// the build from this `new Worker(new URL(...))`, and made once.
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';

GlobalWorkerOptions.workerPort ??= new Worker(new URL('./pdf.worker', import.meta.url), {
  type: 'module',
});

/** The most pages a viewer lays out; a longer PDF says how many more there are. */
export const MAX_PAGES = 50;

/** An open PDF in a viewer: its page count, finding in it, and how to let it go. */
export interface OpenPdf {
  pages: number;
  /**
   * The laid-out pages whose text has every word of `query` (#45), read
   * here from the PDF itself: finding in one PDF never needs the server.
   */
  find(query: string): Promise<number[]>;
  /** Scrolls page `n` into view. */
  show(n: number): void;
  close(): void;
}

/** Every word of `query`, in any case, somewhere in `text`. */
export function hasAllWords(text: string, query: string): boolean {
  const hay = text.toLowerCase();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => hay.includes(w));
}

/**
 * Lays out each page of the PDF at `url` in `into`, as wide as it is,
 * and draws a page only while it is on screen or near it, clearing it
 * again when it scrolls well away: a phone tab holds a few pages' pixels,
 * not fifty (review on #94). Call `close` when the viewer closes.
 */
export async function openPdf(url: string, into: HTMLElement): Promise<OpenPdf> {
  const task = getDocument({ url });
  const pdf = await task.promise;
  const width = Math.max(into.clientWidth, 320);
  const ratio = window.devicePixelRatio || 1;
  /** Pages being drawn or drawn, with the draw in progress if any. */
  const drawn = new Map<HTMLCanvasElement, { cancel(): void } | undefined>();
  const draw = async (canvas: HTMLCanvasElement, n: number) => {
    if (drawn.has(canvas)) return;
    drawn.set(canvas, undefined);
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({
      scale: (width / page.getViewport({ scale: 1 }).width) * ratio,
    });
    if (!drawn.has(canvas)) return;
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const render = page.render({ canvas, viewport });
    drawn.set(canvas, render);
    try {
      await render.promise;
    } catch (err) {
      // Scrolled away mid-draw: cancelled on purpose.
      if ((err as { name?: string }).name !== 'RenderingCancelledException') throw err;
    }
  };
  const clear = (canvas: HTMLCanvasElement) => {
    drawn.get(canvas)?.cancel();
    drawn.delete(canvas);
    // A zero-sized canvas gives its pixels back; the box keeps its place.
    canvas.width = 0;
    canvas.height = 0;
  };
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const canvas = entry.target as HTMLCanvasElement;
        if (entry.isIntersecting) {
          draw(canvas, Number(canvas.dataset['page'])).catch((err) =>
            console.error('could not draw a PDF page', err),
          );
        } else clear(canvas);
      }
    },
    // On screen, or within a screen of it.
    { root: into.closest('dialog'), rootMargin: '100% 0px' },
  );
  try {
    for (let n = 1; n <= Math.min(pdf.numPages, MAX_PAGES); n++) {
      const page = await pdf.getPage(n);
      const box = page.getViewport({ scale: 1 });
      const canvas = document.createElement('canvas');
      canvas.dataset['page'] = String(n);
      canvas.style.width = '100%';
      canvas.style.aspectRatio = `${box.width} / ${box.height}`;
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `Page ${n}`);
      into.append(canvas);
      observer.observe(canvas);
    }
  } catch (err) {
    // Laying the pages out failed: let the document go, then say so.
    observer.disconnect();
    void task.destroy();
    throw err;
  }
  /** Each page's text, read once, when first searched. */
  const texts = new Map<number, Promise<string>>();
  const textOf = (n: number) => {
    let text = texts.get(n);
    if (!text) {
      text = pdf
        .getPage(n)
        .then((page) => page.getTextContent())
        .then((content) => content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
      texts.set(n, text);
    }
    return text;
  };
  const laidOut = Math.min(pdf.numPages, MAX_PAGES);
  return {
    pages: pdf.numPages,
    async find(query) {
      const found: number[] = [];
      for (let n = 1; n <= laidOut; n++) {
        if (hasAllWords(await textOf(n), query)) found.push(n);
      }
      return found;
    },
    show(n) {
      into.querySelector(`canvas[data-page="${n}"]`)?.scrollIntoView({ block: 'start' });
    },
    close() {
      observer.disconnect();
      // Ends this document; the shared worker stays for the next one.
      void task.destroy();
    },
  };
}
