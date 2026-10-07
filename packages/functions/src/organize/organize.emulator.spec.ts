import { deleteApp, initializeApp } from 'firebase-admin/app';
import { type Firestore, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotesTools } from '../mcp/tools';
import { applyAccepted } from './apply';
import type { Proposer } from './claude-proposer';
import { KEEP_DONE_DAYS, STALE_CLAIM_MS, organizeNightly, sweepProposals } from './nightly';
import type { RawProposal } from './proposals';

// Runs inside `npm run e2e`, against the e2e Firestore emulator, under
// its own project id.
const PROJECT = 'demo-mossgoblin-organize';
const HOST = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8180';
const app = initializeApp({ projectId: PROJECT }, 'organize-spec');
let db: Firestore;
const T = Date.parse('2026-10-07T11:00:00Z');
const DAY = 86_400_000;

beforeAll(() => {
  process.env['FIRESTORE_EMULATOR_HOST'] = HOST;
  db = getFirestore(app);
});
beforeEach(async () => {
  const res = await fetch(
    `http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(`could not clear the emulator: ${res.status}`);
});
afterAll(() => deleteApp(app));

async function eric(id: string, body: string, over: Record<string, unknown> = {}) {
  await db.doc(`users/u1/notes/${id}`).set({
    kind: 'text',
    body,
    title: body.split('\n')[0],
    titleSource: 'words',
    links: [],
    tags: [],
    archived: false,
    createdAt: Timestamp.fromMillis(T - DAY),
    updatedAt: Timestamp.fromMillis(T - DAY),
    updatedBy: 'user',
    deviceId: 'phone',
    ...over,
  });
}

const proposer = (raw: RawProposal[]) => vi.fn<Proposer>(async () => raw);

async function proposals() {
  const snap = await db.collection('users/u1/proposals').orderBy('key').get();
  return snap.docs.map((d): Record<string, unknown> => ({ id: d.id, ...d.data() }));
}

describe('organizeNightly', () => {
  it('stores the suggestions that check out as open proposals, changing nothing else', async () => {
    await eric('a', 'Kiln log\nCone 6.');
    await eric('b', 'Firing notes\nShelf 2.');
    const propose = proposer([
      { kind: 'merge', ids: ['a', 'b'], reason: 'One firing.' },
      { kind: 'link', from: 'a', to: ['nope'], reason: 'Not a note.' },
    ]);
    expect(await organizeNightly(db, 'u1', propose, T)).toEqual({
      recent: 2,
      asked: true,
      added: 1,
    });
    expect(await proposals()).toEqual([
      expect.objectContaining({
        kind: 'merge',
        key: 'merge:a,b',
        status: 'open',
        notes: [
          { id: 'a', title: 'Kiln log' },
          { id: 'b', title: 'Firing notes' },
        ],
      }),
    ]);
    expect((await db.doc('users/u1/notes/a').get()).get('archived')).toBe(false);

    // The same suggestion the next night is not proposed again.
    expect((await organizeNightly(db, 'u1', propose, T + DAY)).added).toBe(0);
  });

  it('does not ask Claude when nothing changed this week, or when enough is waiting', async () => {
    await eric('a', 'Kiln log', { updatedAt: Timestamp.fromMillis(T - 8 * DAY) });
    const propose = proposer([]);
    expect(await organizeNightly(db, 'u1', propose, T)).toMatchObject({ asked: false });
    await eric('b', 'Firing notes');
    for (let i = 0; i < 20; i++) {
      await db.doc(`users/u1/proposals/p${i}`).set({ key: `k${i}`, status: 'open' });
    }
    expect(await organizeNightly(db, 'u1', propose, T)).toMatchObject({ asked: false });
    expect(propose).not.toHaveBeenCalled();
  });
});

describe('sweepProposals', () => {
  it('fails a stale claim, deletes old applied and failed ones, keeps dismissed', async () => {
    const put = (id: string, data: Record<string, unknown>) =>
      db
        .doc(`users/u1/proposals/${id}`)
        .set({ key: id, createdAt: Timestamp.fromMillis(T), ...data });
    const old = Timestamp.fromMillis(T - (KEEP_DONE_DAYS + 1) * DAY);
    await put('stuck', {
      status: 'applying',
      claimedAt: Timestamp.fromMillis(T - STALE_CLAIM_MS - 1),
    });
    await put('busy', { status: 'applying', claimedAt: Timestamp.fromMillis(T - 1000) });
    await put('done-old', { status: 'applied', createdAt: old });
    await put('failed-old', { status: 'failed', createdAt: old });
    await put('done-new', { status: 'applied' });
    await put('dismissed-old', { status: 'dismissed', createdAt: old });
    expect(await sweepProposals(db, 'u1', T)).toBe(3);
    const left = Object.fromEntries((await proposals()).map((p) => [p.id, p['status']]));
    expect(left).toEqual({
      busy: 'applying',
      'dismissed-old': 'dismissed',
      'done-new': 'applied',
      stuck: 'failed',
    });
  });
});

describe('applyAccepted', () => {
  async function accepted(id: string, data: Record<string, unknown>) {
    await db.doc(`users/u1/proposals/${id}`).set({
      reason: 'x',
      status: 'accepted',
      createdAt: Timestamp.fromMillis(T),
      decidedAt: Timestamp.fromMillis(T),
      ...data,
    });
  }
  const tools = () => new NotesTools(db, 'u1', () => T);
  const status = async (id: string) => (await db.doc(`users/u1/proposals/${id}`).get()).data();

  it('merges with the organize tool, once, and records it in What Claude changed', async () => {
    await eric('a', 'Kiln log\nCone 6.');
    await eric('b', 'Firing notes\nShelf 2.');
    await accepted('p1', {
      kind: 'merge',
      key: 'merge:a,b',
      notes: [
        { id: 'a', title: 'Kiln log' },
        { id: 'b', title: 'Firing notes' },
      ],
    });
    expect(await applyAccepted(db, 'u1', 'p1', tools(), T)).toBe('applied');
    expect(await status('p1')).toMatchObject({
      status: 'applied',
      outcome: 'Merged into Kiln log',
    });
    expect((await db.doc('users/u1/notes/a').get()).get('archived')).toBe(true);
    const runs = await db.collection('users/u1/activity').get();
    expect(runs.docs.map((d) => d.get('tool'))).toEqual(['merge_notes']);
    // A retried trigger finds it applied and leaves it.
    expect(await applyAccepted(db, 'u1', 'p1', tools(), T)).toBeUndefined();
  });

  it('links and refiles, and says why when the garden moved on', async () => {
    await eric('a', 'Kiln log');
    await eric('b', 'Firing notes');
    await eric('c-vikas', '', { kind: 'concept', title: 'Vikas' });
    await accepted('p1', {
      kind: 'link',
      key: 'link:a>b',
      notes: [
        { id: 'a', title: 'Kiln log' },
        { id: 'b', title: 'Firing notes' },
      ],
    });
    await accepted('p2', {
      kind: 'refile',
      key: 'refile:c-vikas:person:vik',
      notes: [{ id: 'c-vikas', title: 'Vikas' }],
      conceptType: 'person',
      synonyms: ['Vik'],
    });
    await accepted('p3', {
      kind: 'merge',
      key: 'merge:a,zz',
      notes: [
        { id: 'a', title: 'Kiln log' },
        { id: 'zz', title: 'Gone' },
      ],
    });
    await applyAccepted(db, 'u1', 'p1', tools(), T);
    await applyAccepted(db, 'u1', 'p2', tools(), T);
    expect(await applyAccepted(db, 'u1', 'p3', tools(), T)).toBe('failed');
    expect(await status('p1')).toMatchObject({ outcome: 'Linked Firing notes' });
    expect(await status('p2')).toMatchObject({
      outcome: 'filed as a person; added another name: Vik',
    });
    expect(await status('p3')).toMatchObject({ status: 'failed', outcome: 'no note zz' });
    expect((await db.doc('users/u1/notes/a').get()).get('body')).toBe(
      'Kiln log\n\nSee also [[Firing notes]]',
    );
  });

  it('leaves a proposal the gardener has not accepted', async () => {
    await accepted('p1', { kind: 'link', key: 'k', notes: [{ id: 'a', title: 'A' }] });
    await db.doc('users/u1/proposals/p1').update({ status: 'dismissed' });
    expect(await applyAccepted(db, 'u1', 'p1', tools(), T)).toBeUndefined();
    expect((await status('p1'))?.['status']).toBe('dismissed');
  });
});
