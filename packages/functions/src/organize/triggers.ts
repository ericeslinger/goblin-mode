import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { defineString } from 'firebase-functions/params';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { NotesTools } from '../mcp/tools';
import { claudeClient, federationFromEnv } from '../notes/claude-titler';
import { applyAccepted } from './apply';
import { claudeProposer } from './claude-proposer';
import { organizeNightly } from './nightly';

/** The gardener's time zone for the 4 am run; a deploy variable. */
const ORGANIZE_TIME_ZONE = defineString('ORGANIZE_TIME_ZONE', { default: 'UTC' });

/**
 * Every night: suggestions for the owner to accept or dismiss. Runs as
 * the service account the Claude federation rule trusts; off without
 * OWNER_UID or the federation settings.
 */
export const nightlyOrganize = onSchedule(
  {
    schedule: 'every day 04:00',
    timeZone: ORGANIZE_TIME_ZONE,
    retryCount: 0,
    timeoutSeconds: 300,
    serviceAccount: 'goblin-titles@',
  },
  async () => {
    const uid = process.env['OWNER_UID'];
    const config = federationFromEnv(process.env);
    if (!uid || !config) return void logger.info('nightlyOrganize: not set up');
    const report = await organizeNightly(
      getFirestore(),
      uid,
      claudeProposer(claudeClient(config)),
      Date.now(),
    );
    logger.info('nightlyOrganize', report);
  },
);

/** When the owner accepts a proposal: carry it out with the organize tool. */
export const proposalAccepted = onDocumentUpdated(
  'users/{uid}/proposals/{proposalId}',
  async (event) => {
    const before = event.data?.before.get('status');
    const after = event.data?.after.get('status');
    if (before !== 'open' || after !== 'accepted') return;
    const { uid, proposalId } = event.params;
    if (uid !== process.env['OWNER_UID']) return;
    const db = getFirestore();
    const status = await applyAccepted(db, uid, proposalId, new NotesTools(db, uid), Date.now());
    logger.info('proposalAccepted', { proposalId, status });
  },
);
