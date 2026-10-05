import { describe, expect, it } from 'vitest';
import { REGION } from './region';

describe('REGION', () => {
  it('matches the region scripts/deploy.sh builds FUNCTIONS_ORIGIN from', async () => {
    const { readFileSync } = await import('node:fs');
    const deploy = readFileSync(new URL('../../../scripts/deploy.sh', import.meta.url), 'utf8');
    expect(deploy).toContain(`region="${REGION}"`);
  });
});
