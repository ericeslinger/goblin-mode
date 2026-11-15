// Serves the built app for e2e with a single-page-app fallback, the same
// way Workers Static Assets will in production, and forwards the server
// routes to the functions emulator the way the Worker forwards them to
// Cloud Functions (same route table: infra/worker/src/routes.json).
//
// It also stands in for one of the Worker's own routes, the note key
// service's `POST /api/note-key` (note encryption step 2), with the
// stand-in the dev server uses too (note-key-stand-in.mjs). Since note
// text is always sealed (2026-11-15) every journey needs it from the
// first keystroke. This server runs only for e2e on 127.0.0.1 and is
// never deployed. The functions' route
// (`/api/note-key/for`) has no stand-in here: the functions emulator's
// own stand-in derives the same keys without asking (packages/functions
// src/note-keys/stand-in.emulator.ts).
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { standInNoteKey } from './note-key-stand-in.mjs';

const [root, port] = [process.argv[2], Number(process.argv[3] ?? 4300)];
const functionsBase =
  process.env.FUNCTIONS_EMULATOR_BASE ?? 'http://127.0.0.1:5101/demo-mossgoblin/us-central1';
const routes = JSON.parse(
  readFileSync(new URL('../infra/worker/src/routes.json', import.meta.url), 'utf8'),
);
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function functionFor(pathname) {
  for (const [prefix, fn] of routes) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) return fn;
  }
  return undefined;
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/api/note-key') {
    standInNoteKey(req, res);
    return;
  }
  const fn = functionFor(url.pathname);
  if (fn) {
    const target = new URL(`${functionsBase}/${fn}${url.pathname}${url.search}`);
    const upstream = request(
      target,
      {
        method: req.method,
        headers: {
          ...req.headers,
          host: target.host,
          'x-forwarded-host': req.headers.host ?? `127.0.0.1:${port}`,
          'x-forwarded-proto': 'http',
        },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', (err) => {
      res.writeHead(502).end(String(err));
    });
    req.pipe(upstream);
    return;
  }
  const path = normalize(decodeURIComponent(url.pathname));
  let file = join(root, path);
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(root, 'index.html');
  }
  res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} on :${port}`));
