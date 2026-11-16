/**
 * The screen as the maps (#290) see it, for specs: jsdom has no
 * matchMedia and lays nothing out, so every clientWidth is 0. Each
 * returns its undo, for afterEach.
 */

/** Makes every element's clientWidth `px`, as a 380 px box on a phone. */
export function boxWidthIs(px: number): () => void {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => px,
  });
  return () => {
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  };
}

/** Makes `(min-width: 900px)` match, as on a wide screen. */
export function screenIsWide(): () => void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('min-width: 900px'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  return () => {
    delete (window as { matchMedia?: unknown }).matchMedia;
  };
}
