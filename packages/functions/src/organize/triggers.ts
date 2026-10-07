import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { NotesTools } from '../mcp/tools';
import { applyAccepted } from './apply';

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
