// Wiring only: initialize, configure, re-export. Every export deploys, and
// the export names are frozen (see boundary.spec.ts). Emulator-only code
// must never be imported from here.
import { initializeApp } from 'firebase-admin/app';
import { configureFunctions } from './region';

initializeApp();
configureFunctions();

export { health } from './health/health';
export { mcp } from './mcp/http';
export { oauth } from './oauth/http';
export { removeKey, saveKey } from './keys/callables';
export { startRun } from './agent/callables';
export { agentRun, itemAssigned } from './agent/triggers';
export { noteHistory, noteTitle } from './notes/triggers';
export { recipeImport } from './kitchen/triggers';
export { proposalAccepted } from './organize/triggers';
export { sendDuePush } from './push/send-due-push';
export { reminderScheduled, reminderWake } from './push/reminder-wake';
export {
  attachmentCreated,
  attachmentDeleted,
  attachmentTranscribe,
  attachmentUploaded,
} from './attachments/triggers';
