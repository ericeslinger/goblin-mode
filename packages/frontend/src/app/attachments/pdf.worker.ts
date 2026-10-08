// The pdf.js worker (#45), as an entry the build bundles for
// `new Worker(new URL('./pdf.worker', import.meta.url))` in pdf-render.ts.
import 'pdfjs-dist/build/pdf.worker.min.mjs';
