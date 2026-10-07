import { TestBed } from '@angular/core/testing';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
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

function setup() {
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
