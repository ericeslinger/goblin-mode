// Draws a PDF's pages (#45). Imported only when a PDF is opened, so
// pdf.js stays out of the app's first load. Its worker is bundled by
// the build from this `new Worker(new URL(...))`, and made once.
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';

GlobalWorkerOptions.workerPort ??= new Worker(new URL('./pdf.worker', import.meta.url), {
  type: 'module',
});

/** The most pages drawn at once; a longer PDF says how many more there are. */
export const MAX_PAGES = 50;

/**
 * Draws each page of the PDF at `url` into `into`, as wide as it is, one
 * canvas per page. Resolves with the page count; stops early if `live`
 * turns false (the viewer closed).
 */
export async function renderPdf(
  url: string,
  into: HTMLElement,
  live: () => boolean = () => true,
): Promise<number> {
  const task = getDocument({ url });
  const pdf = await task.promise;
  try {
    const width = Math.max(into.clientWidth, 320);
    const scale = window.devicePixelRatio || 1;
    for (let n = 1; n <= Math.min(pdf.numPages, MAX_PAGES) && live(); n++) {
      const page = await pdf.getPage(n);
      const unscaled = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: (width / unscaled.width) * scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = '100%';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `Page ${n}`);
      into.append(canvas);
      await page.render({ canvas, viewport }).promise;
    }
    return pdf.numPages;
  } finally {
    // Ends the document and its worker.
    void task.destroy();
  }
}
