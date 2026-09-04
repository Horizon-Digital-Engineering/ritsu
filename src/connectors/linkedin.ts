/**
 * LinkedIn connector — publish-only (their API gives normal apps no real
 * feed-read access, so there's nothing to read; posting is the whole job,
 * and posting is the gated action anyway).
 *
 * Auth is an OAuth 2.0 access token obtained out-of-band (the operator runs
 * the LinkedIn OAuth flow once and pastes the token + their author URN into
 * the Extensions tab). Stored in the SecretStore (namespace 'linkedin') and
 * read here in-process only. No SDK / lib — it's a single Bearer-auth POST
 * to the Posts API.
 */
import type { SecretStore } from '../auth/secret-store.js';
import { logger } from '../util/log.js';

export const LINKEDIN_NS = 'linkedin';

/** access_token + author_urn are required; api_version (YYYYMM) is optional
 *  and defaults below — LinkedIn deprecates versions on a rolling basis, so
 *  it's exposed for the operator to bump. */
export const LINKEDIN_SECRET_KEYS = ['access_token', 'author_urn', 'api_version'] as const;

const DEFAULT_VERSION = '202401';

export interface LinkedInConfig {
  accessToken: string;
  /** urn:li:person:XXXX (personal) or urn:li:organization:XXXX (company page). */
  authorUrn: string;
  apiVersion: string;
}

export function loadLinkedInConfig(secrets: SecretStore): LinkedInConfig | null {
  const accessToken = secrets.get(LINKEDIN_NS, 'access_token');
  const authorUrn = secrets.get(LINKEDIN_NS, 'author_urn');
  if (!accessToken || !authorUrn) return null;
  return {
    accessToken,
    authorUrn,
    apiVersion: secrets.get(LINKEDIN_NS, 'api_version')?.trim() || DEFAULT_VERSION,
  };
}

/** Publish a text post to the configured author (person or company page).
 *  Returns the post URN + a viewable URL.
 *
 *  `fetchImpl` is the test seam, matching the convention in health.ts and the
 *  network tools — this reaches a third-party API that must not be called from
 *  a test run. */
export async function publishPost(
  cfg: LinkedInConfig,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; url: string }> {
  const res = await fetchImpl('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.accessToken}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
      'LinkedIn-Version': cfg.apiVersion,
    },
    body: JSON.stringify({
      author: cfg.authorUrn,
      commentary: text,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LinkedIn ${res.status}: ${body.slice(0, 300)}`);
  }
  // The new post's URN comes back in a response header, not the body.
  const id = res.headers.get('x-restli-id') ?? res.headers.get('x-linkedin-id') ?? '(unknown)';
  logger.info('linkedin.posted', { id, len: text.length });
  return { id, url: id.startsWith('urn:') ? `https://www.linkedin.com/feed/update/${id}` : 'https://www.linkedin.com/feed/' };
}
