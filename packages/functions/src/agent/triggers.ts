import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { GARDEN_AGENT } from '@mossgoblin/schema';
import { firestoreKeyStore } from '../keys/firestore-store';
import { sealerFromEnv } from '../keys/sealer';
import { withKey } from '../keys/use';
import { contextOrNone, modulesOrNone } from '../mcp/http';
import { NotesTools } from '../mcp/tools';
import { executeRun } from './core';
import { firestoreRunStore } from './firestore-store';
import { gardenTools } from './garden-tools';
import { type AgentModel, anthropicModel } from './model';
import { standInModel } from './stand-in';

/** The account that may open gardeners' keys (decrypt only), as transcription's. */
const RUNNER_ACCOUNT = 'goblin-runner@';

/**
 * A run asked for (#144 step 3): the garden's own agent, on the
 * gardener's Anthropic key, does the sent note now. The key is opened
 * for this run alone; the model built from it lives no longer.
 */
export const agentRun = onDocumentCreated(
  {
    document: 'users/{uid}/runs/{runId}',
    serviceAccount: RUNNER_ACCOUNT,
    memory: '1GiB',
    timeoutSeconds: 540,
  },
  async (event) => {
    const { uid, runId } = event.params;
    const db = getFirestore();
    const keys = firestoreKeyStore(db);
    const keyDeps = { store: keys, sealer: sealerFromEnv(process.env), marks: keys };
    const outcome = await executeRun(
      {
        store: firestoreRunStore(db),
        withModel: (owner, use) => {
          const standIn = standInModel(process.env);
          return standIn
            ? use(standIn)
            : withKey(keyDeps, owner, 'anthropic', 'do it now', (key) => use(anthropicModel(key)));
        },
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

export type { AgentModel };
