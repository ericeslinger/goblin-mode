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

describe('STORAGE_REGION', () => {
  it('is checked in scripts/deploy.sh against the shape of a Google region', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('../../../scripts/deploy.sh', import.meta.url), 'utf8');
    const pattern = /"\$STORAGE_REGION" =~ (\S+) \]\]/.exec(text)?.[1];
    expect(pattern).toBeDefined();
    const shape = new RegExp(pattern!);
    for (const ok of ['us-east1', 'us-central1', 'europe-west12', 'northamerica-northeast1']) {
      expect(shape.test(ok), ok).toBe(true);
    }
    // us-east-1 cost the #92 deploy (2026-10-08).
    for (const bad of ['us-east-1', 'us-east', 'US-EAST1', 'us-east1 ', '']) {
      expect(shape.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
