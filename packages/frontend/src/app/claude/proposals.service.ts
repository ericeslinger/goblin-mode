import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { type ProposalKind, type ProposalStatus, paths } from '@mossgoblin/schema';
import {
  type Firestore,
  Timestamp,
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
} from 'firebase/firestore';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { NOW } from '../platform/platform';

/** A nightly suggestion as the app shows it; times in milliseconds. */
export interface ProposalRecord {
  id: string;
  kind: ProposalKind;
  reason: string;
  notes: { id: string; title: string }[];
  title?: string;
  conceptType?: string;
  synonyms?: string[];
  status: ProposalStatus;
  outcome?: string;
  createdAt?: number;
  decidedAt?: number;
}

/** The Firestore calls the service makes, as a seam for unit specs. */
export interface ProposalsApi {
  /** The latest proposals, newest first. */
  listen(
    db: Firestore,
    path: string,
    next: (docs: { id: string; data: Record<string, unknown> }[]) => void,
    error: (err: unknown) => void,
  ): () => void;
  /** Accept or dismiss: the only change the rules allow the app. */
  decide(db: Firestore, path: string, status: 'accepted' | 'dismissed', at: number): Promise<void>;
}

/** How many proposals the app reads; older ones stay stored. */
export const PROPOSALS_READ = 100;
/** How long a failed suggestion stays in view, with why. */
export const FAILED_SHOWN_MS = 3 * 86_400_000;

export const PROPOSALS_API = new InjectionToken<ProposalsApi>('proposals-api', {
  providedIn: 'root',
  factory: () => ({
    listen: (db, path, next, error) =>
      onSnapshot(
        query(collection(db, path), orderBy('createdAt', 'desc'), limit(PROPOSALS_READ)),
        (snap) => next(snap.docs.map((d) => ({ id: d.id, data: d.data() }))),
        error,
      ),
    decide: (db, path, status, at) =>
      updateDoc(doc(db, path), { status, decidedAt: Timestamp.fromMillis(at) }),
  }),
});

const millis = (v: unknown) => (v as { toMillis?: () => number } | undefined)?.toMillis?.();
const strings = (v: unknown) => (Array.isArray(v) ? v.map(String) : undefined);

function toRecord(id: string, data: Record<string, unknown>): ProposalRecord {
  return {
    id,
    kind: data['kind'] as ProposalKind,
    reason: String(data['reason'] ?? ''),
    notes: Array.isArray(data['notes'])
      ? data['notes'].map((n: { id?: unknown; title?: unknown }) => ({
          id: String(n.id ?? ''),
          title: String(n.title ?? ''),
        }))
      : [],
    title: typeof data['title'] === 'string' ? data['title'] : undefined,
    conceptType: typeof data['conceptType'] === 'string' ? data['conceptType'] : undefined,
    synonyms: strings(data['synonyms']),
    status: (data['status'] as ProposalStatus) ?? 'open',
    outcome: typeof data['outcome'] === 'string' ? data['outcome'] : undefined,
    createdAt: millis(data['createdAt']),
    decidedAt: millis(data['decidedAt']),
  };
}

/**
 * The nightly organize run's suggestions (#35). Accept and dismiss only
 * change the proposal, through the persistent cache and never awaited,
 * so they work offline; a function carries out an accepted one with the
 * organize tool, and What Claude changed records it.
 */
@Injectable({ providedIn: 'root' })
export class ProposalsService {
  private readonly fb = inject(FIREBASE);
  private readonly api = inject(PROPOSALS_API);
  private readonly auth = inject(AuthService);
  private readonly now = inject(NOW);

  private readonly all = signal<ProposalRecord[]>([]);
  readonly loaded = signal(false);

  /** Waiting for the gardener, plus accepted ones not yet done and recent failures. */
  readonly shown = computed(() => {
    const now = this.now();
    return this.all().filter(
      (p) =>
        p.status === 'open' ||
        p.status === 'accepted' ||
        p.status === 'applying' ||
        (p.status === 'failed' && now - (p.decidedAt ?? 0) < FAILED_SHOWN_MS),
    );
  });
  readonly open = computed(() => this.all().filter((p) => p.status === 'open').length);

  private uid?: string;
  private stop?: () => void;

  constructor() {
    effect(() => {
      const uid = this.auth.user()?.uid;
      if (uid === this.uid) return;
      this.stop?.();
      this.stop = undefined;
      this.uid = uid;
      this.all.set([]);
      this.loaded.set(false);
      if (!uid) return;
      this.stop = this.api.listen(
        this.fb.db,
        paths.proposals(uid),
        (docs) => {
          this.all.set(docs.map((d) => toRecord(d.id, d.data)));
          this.loaded.set(true);
        },
        (err) => console.error('proposals listener', err),
      );
    });
    inject(DestroyRef).onDestroy(() => this.stop?.());
  }

  accept(id: string): void {
    this.decide(id, 'accepted');
  }

  dismiss(id: string): void {
    this.decide(id, 'dismissed');
  }

  private decide(id: string, status: 'accepted' | 'dismissed'): void {
    if (!this.uid) return;
    const p = this.all().find((x) => x.id === id);
    if (p?.status !== 'open') return;
    const at = this.now();
    // Shown at once; the listener confirms it.
    this.all.update((list) => list.map((x) => (x.id === id ? { ...x, status, decidedAt: at } : x)));
    this.api
      .decide(this.fb.db, `${paths.proposals(this.uid)}/${id}`, status, at)
      .catch((err) => console.error('proposal decision', err));
  }
}
