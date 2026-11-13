import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { GARDEN_AGENT } from '@mossgoblin/schema';
import { NoteCodec } from '../mcp/note-text';
import { dataKeyFor } from '../note-keys/client';
import { firestoreKeyStore } from '../keys/firestore-store';
import { sealerFromEnv } from '../keys/sealer';
import { withKey } from '../keys/use';
import { contextOrNone, modulesOrNone } from '../mcp/http';
import { NotesTools } from '../mcp/tools';
import { assignedOnWrite } from './assigned';
import { executeRun, runRequested } from './core';
import { firestoreRunStore } from './firestore-store';
import { gardenTools } from './garden-tools';
import { executeItemRun } from './items';
import { gardenOnArrival } from './request';
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
      // One set of tools, so one codec, for the run: the item's note is
      // read through them, its text opened when sealed (2026-11-13).
      const tools = new NotesTools(db, uid).as(GARDEN_AGENT);
      const outcome = await executeItemRun(
        {
          store,
          withModel,
          now: () => Date.now(),
          tools: () => tools,
          // A note in Trash (#217) takes no findings.
          body: (_owner, noteId) => tools.noteBody(noteId),
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
    const { uid, noteId } = event.params;
    const started = await assignedOnWrite(
      getFirestore(),
      new NoteCodec(uid, dataKeyFor),
      uid,
      noteId,
      event.data?.before.data(),
      event.data?.after.data(),
      Date.now(),
      logger,
    );
    if (typeof started === 'number' && started) logger.info('itemAssigned', { noteId, started });
  },
);

/**
 * Garden on arrival (#214, step 1 of #155): a note's first settle, with
 * the switch on in Settings and a key kept, sends it to the garden's
 * agent with no ask and starts its run. The note was written offline
 * as ever; this runs once that settle reaches the server.
 */
export const noteArrived = onDocumentWritten(
  { document: 'users/{uid}/notes/{noteId}' },
  async (event) => {
    const { uid, noteId } = event.params;
    const outcome = await gardenOnArrival(
      getFirestore(),
      uid,
      noteId,
      event.data?.before.data(),
      event.data?.after.data(),
    );
    if (outcome === 'sealed') {
      logger.warn('noteArrived left a sealed note as stored: it cannot be opened here', {
        noteId,
      });
    } else if (outcome !== 'not-arrival') logger.info('noteArrived', { noteId, outcome });
  },
);

export type { AgentModel };
