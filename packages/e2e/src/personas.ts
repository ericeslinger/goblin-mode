export interface Persona {
  email: string;
  password: string;
  /** A fixed uid, so emulator settings (OWNER_UID in e2e.sh) can name it. */
  uid: string;
}

/** Eric, the one owner. Journeys sign in as him through /dev-sign-in. */
export const OWNER: Persona = {
  email: 'owner@mossgoblin.test',
  password: 'mossgoblin-e2e-pass',
  uid: 'e2e-owner',
};
