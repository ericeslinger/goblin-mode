import { describe, expect, it } from 'vitest';
import { healthBody } from './health';

describe('healthBody', () => {
  it('reports the revision, or local outside Cloud Run', () => {
    expect(healthBody('health-00002')).toMatchObject({ ok: true, revision: 'health-00002' });
    expect(healthBody(undefined).revision).toBe('local');
  });
});
