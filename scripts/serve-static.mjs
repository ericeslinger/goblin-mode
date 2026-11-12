// Serves the built app for e2e with a single-page-app fallback, the same
// way Workers Static Assets will in production, and forwards the server
// routes to the functions emulator the way the Worker forwards them to
// Cloud Functions (same route table: infra/worker/src/routes.json).
//
// It also stands in for one of the Worker's own routes, the note key
// service's `POST /api/note-key` (note encryption step 2): the Worker's
// derivation (packages/schema/src/note-key.ts, loaded as TypeScript
// through Node's type stripping) over the fixed development master, for
// an Auth emulator token, which is unsigned. This server runs only for
// e2e on 127.0.0.1 and is never deployed. The functions' route
// (`/api/note-key/for`) has no stand-in here: the functions emulator's
// own stand-in derives the same keys without asking (packages/functions
// src/note-keys/stand-in.emulator.ts).
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { DEV_NOTE_KEYS_MASTER } from '../packages/functions/src/note-keys/dev-master.emulator.ts';
import {
  NOTE_KEY_VERSION,
  bytesToBase64,
  deriveNoteKey,
  masterFromBase64,
} from '../packages/schema/src/note-key.ts';

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

const EMULATOR_PROJECT = 'demo-mossgoblin';
const devMaster = masterFromBase64(DEV_NOTE_KEYS_MASTER);

/** The uid of an Auth emulator ID token for the e2e project, or undefined. */
function emulatorUid(authorization) {
  const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1];
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const issuer = `https://securetoken.google.com/${EMULATOR_PROJECT}`;
    if (claims.iss !== issuer || claims.aud !== EMULATOR_PROJECT) return undefined;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) return undefined;
    return typeof claims.sub === 'string' && claims.sub ? claims.sub : undefined;
  } catch {
    return undefined;
  }
}

/** As the Worker's appNoteKey (infra/worker/src/note-key.ts), for emulator tokens. */
async function noteKey(req, res) {
  const plain = (status, text) =>
    res
      .writeHead(status, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      })
      .end(text);
  if (req.method !== 'POST') return plain(405, 'POST only');
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return plain(403, 'not from another site');
  const uid = emulatorUid(req.headers.authorization);
  if (!uid) return plain(401, 'sign in first');
  const key = await deriveNoteKey(devMaster, uid, NOTE_KEY_VERSION);
  res
    .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    .end(JSON.stringify({ v: NOTE_KEY_VERSION, key: bytesToBase64(key) }));
}

function functionFor(pathname) {
  for (const [prefix, fn] of routes) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) return fn;
  }
  return undefined;
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/api/note-key') {
    req.resume();
    noteKey(req, res).catch((err) => res.writeHead(500).end(String(err)));
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
