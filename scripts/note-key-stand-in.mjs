// EMULATOR_ONLY: a stand-in for the Worker's note key service,
// `POST /api/note-key` (note encryption step 2; DESIGN.md, Note
// encryption, Localhost), for localhost only. It derives a gardener's
// key as the Worker does (packages/schema/src/note-key.ts, loaded as
// TypeScript through Node's type stripping) over the fixed, public
// development master, for an Auth emulator token, which is unsigned and
// so is read, not verified. Note text is always sealed (2026-11-15), so
// without it nothing typed on localhost could be saved.
//
// Used two ways, never deployed and never bundled:
// - by the e2e static server (serve-static.mjs), which imports it;
// - run on its own beside the dev emulators (scripts/emulators.sh):
//   `node scripts/note-key-stand-in.mjs <port>`, listening on 127.0.0.1,
//   which `ng serve` proxies `/api/note-key` to (packages/frontend,
//   proxy.dev.json).
// The functions' route (`/api/note-key/for`) has no stand-in here: the
// functions emulator's own stand-in derives the same keys without
// asking (packages/functions/src/note-keys/stand-in.emulator.ts).
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { DEV_NOTE_KEYS_MASTER } from '../packages/functions/src/note-keys/dev-master.emulator.ts';
import {
  NOTE_KEY_VERSION,
  bytesToBase64,
  deriveNoteKey,
  masterFromBase64,
} from '../packages/schema/src/note-key.ts';

/** The emulator project both localhost configurations use (packages/frontend/src/app/firebase.ts). */
const EMULATOR_PROJECT = 'demo-mossgoblin';
const devMaster = masterFromBase64(DEV_NOTE_KEYS_MASTER);

/** The uid of an Auth emulator ID token for the emulator project, or undefined. */
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

/** Answers one `/api/note-key` request; the body, if any, is read and dropped. */
export function standInNoteKey(req, res) {
  req.resume();
  noteKey(req, res).catch((err) => res.writeHead(500).end(String(err)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 5099);
  createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://x');
    if (pathname === '/api/note-key') return standInNoteKey(req, res);
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not here');
  }).listen(port, '127.0.0.1', () => console.log(`note key stand-in on :${port}`));
}
