// Serves the built app for e2e with a single-page-app fallback, the same
// way Workers Static Assets will in production, and forwards the server
// routes to the functions emulator the way the Worker forwards them to
// Cloud Functions (same route table: infra/worker/src/routes.json).
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { extname, join, normalize } from 'node:path';

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
