import { describe, expect, it } from 'vitest';
import { federationFromEnv } from './claude-titler';

describe('federationFromEnv', () => {
  it('is off until the rule and organization are set', () => {
    expect(federationFromEnv({})).toBeUndefined();
    expect(federationFromEnv({ ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_x' })).toBeUndefined();
  });

  it('reads the ids the deploy writes, optional ones when present', () => {
    expect(
      federationFromEnv({
        ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_x',
        ANTHROPIC_ORGANIZATION_ID: 'org',
        ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_x',
        ANTHROPIC_WORKSPACE_ID: '',
      }),
    ).toEqual({
      federationRuleId: 'fdrl_x',
      organizationId: 'org',
      serviceAccountId: 'svac_x',
      workspaceId: undefined,
    });
  });
});
