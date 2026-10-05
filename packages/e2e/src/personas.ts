export interface Persona {
  email: string;
  password: string;
}

/** Eric, the one owner. Journeys sign in as him through /dev-sign-in. */
export const OWNER: Persona = { email: 'owner@goblin.test', password: 'goblin-e2e-pass' };
