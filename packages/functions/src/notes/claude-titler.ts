import Anthropic from '@anthropic-ai/sdk';
import { oidcFederationProvider } from '@anthropic-ai/sdk/lib/credentials/oidc-federation';
import type { Titler } from './title';

/** A small, cheap model is plenty for a few words (DESIGN.md, Titles). */
export const TITLE_MODEL = 'claude-haiku-4-5';
/** How much of a note the model sees. */
export const TITLE_CONTEXT_CHARS = 2000;

const AUDIENCE = 'https://api.anthropic.com';
const METADATA_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity' +
  `?audience=${encodeURIComponent(AUDIENCE)}&format=full`;

const SYSTEM =
  'You title notes in a personal notes app. Reply with the title only: two to six words, ' +
  "in the note's language, plain text, no quotes and no final period. Prefer the note's own words.";

/** The federation settings, from the deploy's `.env.<project>` file. */
export interface FederationConfig {
  federationRuleId: string;
  organizationId: string;
  serviceAccountId?: string;
  workspaceId?: string;
}

/** Reads the settings; undefined when this deployment has not set them up. */
export function federationFromEnv(env: NodeJS.ProcessEnv): FederationConfig | undefined {
  const federationRuleId = env['ANTHROPIC_FEDERATION_RULE_ID'];
  const organizationId = env['ANTHROPIC_ORGANIZATION_ID'];
  if (!federationRuleId || !organizationId) return undefined;
  return {
    federationRuleId,
    organizationId,
    serviceAccountId: env['ANTHROPIC_SERVICE_ACCOUNT_ID'] || undefined,
    workspaceId: env['ANTHROPIC_WORKSPACE_ID'] || undefined,
  };
}

/** The function's own Google identity token, from the metadata server. */
async function googleIdentityToken(): Promise<string> {
  const res = await fetch(METADATA_URL, { headers: { 'Metadata-Flavor': 'Google' } });
  if (!res.ok) throw new Error(`metadata server: ${res.status}`);
  return res.text();
}

/**
 * Claude through workload identity federation: no API key. The SDK
 * exchanges the function's Google identity token for a short-lived
 * Claude token and refreshes it before expiry.
 */
export function claudeTitler(config: FederationConfig): Titler {
  const client = new Anthropic({
    credentials: oidcFederationProvider({
      identityTokenProvider: googleIdentityToken,
      ...config,
      baseURL: AUDIENCE,
      fetch,
    }),
  });
  return async (body) => {
    const message = await client.messages.create({
      model: TITLE_MODEL,
      max_tokens: 64,
      system: SYSTEM,
      messages: [
        { role: 'user', content: `<note>\n${body.slice(0, TITLE_CONTEXT_CHARS)}\n</note>` },
      ],
    });
    for (const block of message.content) if (block.type === 'text') return block.text;
    return '';
  };
}
