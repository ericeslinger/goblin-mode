import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { GARDEN_AGENT, RUN_STALE_MS, assignedItems, paths } from '@mossgoblin/schema';
import { firestoreKeyStore } from '../keys/firestore-store';
import { sealerFromEnv } from '../keys/sealer';
import { withKey } from '../keys/use';
import { contextOrNone, modulesOrNone } from '../mcp/http';
import { NotesTools } from '../mcp/tools';
import { executeRun, runRequested } from './core';
import { firestoreRunStore } from './firestore-store';
import { gardenTools } from './garden-tools';
import { executeItemRun, itemRunId } from './items';
import { type AgentModel, anthropicModel } from './model';
import { standInModel } from './stand-in';

/** The account that may open gardeners' keys (decrypt only), as transcription's. */
const RUNNER_ACCOUNT = 'goblin-runner@';

/**
 * A run asked for (#144 step 3): the garden's own agent, on the
 * gardener's Anthropic key, does the sent note now. The key is opened
 * for this run alone; the model built from it lives no longer.
 */
export const agentRun = onDocumentWritten(
  {
    document: 'users/{uid}/runs/{runId}',
    serviceAccount: RUNNER_ACCOUNT,
    memory: '1GiB',
    timeoutSeconds: 540,
  },
  async (event) => {
    // On every write, so a run reset to `requested` for a retry runs
    // too (review on #158); a claim's own write to `working` does not.
    if (!runRequested(event.data?.before.data(), event.data?.after.data())) return;
    const { uid, runId } = event.params;
    const db = getFirestore();
    const keys = firestoreKeyStore(db);
    const keyDeps = { store: keys, sealer: sealerFromEnv(process.env), marks: keys };
    const store = firestoreRunStore(db);
    const withModel = <T>(owner: string, use: (m: AgentModel) => Promise<T>) => {
      const standIn = standInModel(process.env);
      return standIn
        ? use(standIn)
        : withKey(keyDeps, owner, 'anthropic', 'do it now', (key) => use(anthropicModel(key)));
    };
    // An item assigned with @goblin (step 4): research, then written under it.
    if (event.data?.after.data()?.['kind'] === 'item') {
      const outcome = await executeItemRun(
        {
          store,
          withModel,
          now: () => Date.now(),
          tools: (owner) => new NotesTools(db, owner).as(GARDEN_AGENT),
          body: async (owner, noteId) => {
            const doc = await db.doc(paths.note(owner, noteId)).get();
            return doc.exists ? String(doc.get('body') ?? '') : undefined;
          },
        },
        uid,
        runId,
      );
      logger.info('agentRun item', { outcome });
      return;
    }
    const outcome = await executeRun(
      {
        store,
        withModel,
        garden: async (owner, scope) => {
          const tools = new NotesTools(db, owner).as(GARDEN_AGENT);
          const [context, modules] = await Promise.all([
            contextOrNone(tools),
            modulesOrNone(tools),
          ]);
          return { tools, garden: await gardenTools(tools, context, modules, scope) };
        },
        now: () => Date.now(),
      },
      uid,
      runId,
    );
    logger.info('agentRun', { outcome });
  },
);

/**
 * Items assigned to the assistant (#144 step 4): when a note settles,
 * each unticked item ending in @goblin that has no run yet gets one.
 * The run id is the note's and the item's, so a later settle, or an
 * edit elsewhere in the note, never starts it twice.
 */
export const itemAssigned = onDocumentWritten(
  { document: 'users/{uid}/notes/{noteId}' },
  async (event) => {
    const after = event.data?.after.data();
    if (!after || after['archived'] === true) return;
    const settled = after['settledAt'];
    const was = event.data?.before.data()?.['settledAt'];
    const ms = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : undefined);
    if (ms(settled) === undefined || ms(settled) === ms(was)) return;
    const items = assignedItems(String(after['body'] ?? '')).filter((i) => !i.done);
    if (!items.length) return;
    const { uid, noteId } = event.params;
    const db = getFirestore();
    let started = 0;
    for (const item of items) {
      const ref = db.doc(paths.run(uid, itemRunId(noteId, item.key)));
      const made = await db.runTransaction(async (tx) => {
        const had = (await tx.get(ref)).data();
        if (had) {
          // Started again only when it failed for a reason a later settle
          // can mend, or was lost with its function (review on #158).
          const since = had['startedAt'] ?? had['createdAt'];
          const age = since instanceof Timestamp ? Date.now() - since.toMillis() : Infinity;
          const lost =
            (had['status'] === 'requested' || had['status'] === 'working') && age > RUN_STALE_MS;
          const mendable = had['status'] === 'failed' && had['retryable'] === true;
          if (!lost && !mendable) return false;
        }
        tx.set(ref, {
          kind: 'item',
          noteId,
          itemText: item.text,
          itemKey: item.key,
          status: 'requested',
          attempt: (typeof had?.['attempt'] === 'number' ? had['attempt'] : 0) + 1,
          steps: [],
          createdAt: FieldValue.serverTimestamp(),
        });
        return true;
      });
      if (made) started++;
    }
    if (started) logger.info('itemAssigned', { noteId, started });
  },
);

export type { AgentModel };
