import { describe, expect, it } from 'vitest';
import { REGION } from './region';

describe('REGION', () => {
  it.each(['deploy.sh', 'deploy-functions.sh'])(
    'matches the region scripts/%s deploys to',
    async (script) => {
      const { readFileSync } = await import('node:fs');
      const text = readFileSync(new URL(`../../../scripts/${script}`, import.meta.url), 'utf8');
      expect(text).toContain(`region="${REGION}"`);
    },
  );
});
