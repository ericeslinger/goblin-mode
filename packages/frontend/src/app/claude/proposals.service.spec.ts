import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type DataKey, aadFor, newDataKey, recordAadFor, sealText } from '@mossgoblin/schema';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { NoteKeyService } from '../notes/note-key.service';
import { NOW } from '../platform/platform';
import { FakeAuthService, fakeFirebase } from '../testing/fakes';
import {
  FAILED_SHOWN_MS,
  PROPOSALS_API,
  type ProposalsApi,
  ProposalsService,
} from './proposals.service';

const T = Date.parse('2026-10-07T12:00:00Z');
const at = (ms: number) => ({ toMillis: () => ms });

function setup(key = signal<DataKey | undefined>(undefined)) {
  let push: Parameters<ProposalsApi['listen']>[2] = () => undefined;
  const stop = vi.fn();
  const api = {
    listen: vi.fn((_db, _path, next) => {
      push = next;
      return stop;
    }),
    // Offline, the write never settles; nothing may wait on it.
    decide: vi.fn(() => new Promise<void>(() => undefined)),
  } satisfies ProposalsApi;
  const auth = new FakeAuthService();
  auth.user.set({ uid: 'u1' } as User);
  TestBed.configureTestingModule({
    providers: [
      { provide: PROPOSALS_API, useValue: api },
      { provide: FIREBASE, useValue: fakeFirebase(true) },
      { provide: AuthService, useValue: auth },
      { provide: NOW, useValue: () => T },
      { provide: NoteKeyService, useValue: { key } },
    ],
  });
  const service = TestBed.inject(ProposalsService);
  TestBed.tick();
  return { service, api, auth, stop, push: (docs: Parameters<typeof push>[0]) => push(docs) };
}

const doc = (id: string, status: string, over: Record<string, unknown> = {}) => ({
  id,
  data: {
    kind: 'merge',
    reason: 'Same firing.',
    notes: [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ],
    status,
    createdAt: at(T - 1000),
    ...over,
  },
});

describe('ProposalsService', () => {
  it("listens to the owner's proposals and shows the ones still in play", () => {
    const { service, api, push } = setup();
    expect(api.listen).toHaveBeenCalledWith(
      expect.anything(),
      'users/u1/proposals',
      expect.any(Function),
      expect.any(Function),
    );
    push([
      doc('open', 'open'),
      doc('accepted', 'accepted'),
      doc('applying', 'applying'),
      doc('applied', 'applied'),
      doc('dismissed', 'dismissed'),
      doc('failed-now', 'failed', { decidedAt: at(T - 1000) }),
      doc('failed-old', 'failed', { decidedAt: at(T - FAILED_SHOWN_MS - 1) }),
    ]);
    expect(service.shown().map((p) => p.id)).toEqual([
      'open',
      'accepted',
      'applying',
      'failed-now',
    ]);
    expect(service.open()).toBe(1);
  });

  it('accepts and dismisses at once, through the cache, only while open', () => {
    const { service, api, push } = setup();
    push([doc('p1', 'open'), doc('p2', 'open'), doc('p3', 'applied')]);
    service.accept('p1');
    service.dismiss('p2');
    service.accept('p3');
    service.accept('p1');
    expect(api.decide.mock.calls).toEqual([
      [expect.anything(), 'users/u1/proposals/p1', 'accepted', T],
      [expect.anything(), 'users/u1/proposals/p2', 'dismissed', T],
    ]);
    expect(service.shown().map((p) => [p.id, p.status])).toEqual([['p1', 'accepted']]);
  });

  it('stops listening and forgets everything on sign-out', () => {
    const { service, auth, stop, push } = setup();
    push([doc('p1', 'open')]);
    auth.user.set(null);
    TestBed.tick();
    expect(stop).toHaveBeenCalled();
    expect(service.shown()).toEqual([]);
  });
});

describe('ProposalsService, sealed suggestions (step 3e, 2026-11-13)', () => {
  const dataKey = newDataKey();
  const seal = (id: string, field: 'title' | 'reason', text: string) =>
    sealText(dataKey, recordAadFor('u1', 'proposals', id, field), text);

  it('opens a sealed title and reason with the key', () => {
    const { service, push } = setup(signal<DataKey | undefined>(dataKey));
    push([
      doc('p1', 'open', {
        title: seal('p1', 'title', 'Kiln'),
        reason: seal('p1', 'reason', 'Both fire'),
      }),
    ]);
    const [p] = service.shown();
    expect(p).toMatchObject({ title: 'Kiln', reason: 'Both fire' });
    expect(p.sealed).toBeUndefined();
  });

  it('shows no sealed text without the key, and opens it when the key arrives', () => {
    const key = signal<DataKey | undefined>(undefined);
    const { service, push } = setup(key);
    push([
      doc('p1', 'open', {
        title: seal('p1', 'title', 'Kiln'),
        reason: seal('p1', 'reason', 'Both fire'),
      }),
    ]);
    const [locked] = service.shown();
    expect(locked).toMatchObject({ reason: '', sealed: true });
    expect(locked.title).toBeUndefined();
    expect(JSON.stringify(service.shown())).not.toContain('\uE000');
    key.set(dataKey);
    expect(service.shown()[0]).toMatchObject({ title: 'Kiln', reason: 'Both fire' });
    expect(service.shown()[0].sealed).toBeUndefined();
  });

  it('does not open a value sealed for another proposal, field or note', () => {
    const { service, push } = setup(signal<DataKey | undefined>(dataKey));
    push([
      doc('p1', 'open', { reason: seal('p2', 'reason', 'moved') }),
      doc('p3', 'open', { reason: seal('p3', 'title', 'swapped') }),
      doc('p4', 'open', { reason: sealText(dataKey, aadFor('u1', 'p4', 'title'), 'a note') }),
    ]);
    expect(service.shown().map((p) => [p.reason, p.sealed])).toEqual([
      ['', true],
      ['', true],
      ['', true],
    ]);
  });

  it('keeps a decision made here over a sealed one, as for a plain one', () => {
    const { service, push } = setup(signal<DataKey | undefined>(dataKey));
    push([doc('p1', 'open', { reason: seal('p1', 'reason', 'Both fire') })]);
    service.accept('p1');
    expect(service.shown()[0]).toMatchObject({ status: 'accepted', reason: 'Both fire' });
  });
});
