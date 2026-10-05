// Wiring only: initialize, configure, re-export. Every export deploys, and
// the export names are frozen (see boundary.spec.ts). Emulator-only code
// must never be imported from here.
import { initializeApp } from 'firebase-admin/app';
import { configureFunctions } from './region';

initializeApp();
configureFunctions();

export { health } from './health/health';
