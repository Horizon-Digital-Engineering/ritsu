/**
 * Runtime selection for the MemoryBackend seam, read from the encrypted
 * SecretStore (namespace 'flashback') — the same operator-managed, at-rest-
 * encrypted mechanism the email + social connectors use, configured in the
 * admin Secrets UI. Nothing here is an env var.
 *
 * Keys in the 'flashback' namespace:
 *   url               base URL of the flashback server
 *   token             bearer token for it
 *   mode              sqlite | flashback | dual  (optional; defaults to 'dual'
 *                     once url + token are set, so configuring credentials opts
 *                     the install into the safe dual-run)
 *   timeout_ms        per-request timeout (default 5000)
 *   proposal_poll_ms  proposal sweep interval (default 60000)
 *
 * With no url/token the backend is sqlite-only — the standalone on-box
 * behavior, nothing touches the network. A stored mode of flashback/dual
 * without credentials degrades to sqlite and logs one warning rather than
 * failing every turn; an unrecognized stored mode does the same.
 */
import type { SecretStore } from '../auth/secret-store.js';
import { logger } from '../util/log.js';

export type MemoryMode = 'sqlite' | 'flashback' | 'dual';

export interface MemoryConfig {
  mode: MemoryMode;
  flashback?: { endpoint: string; token: string; timeoutMs: number; proposalPollMs: number };
}

/** SecretStore namespace + keys for the flashback backend, surfaced by the
 *  admin Secrets UI (mirrors EMAIL_NS / EMAIL_SECRET_KEYS). */
export const FLASHBACK_NS = 'flashback';
export const FLASHBACK_SECRET_KEYS = ['url', 'token', 'mode', 'timeout_ms', 'proposal_poll_ms'] as const;

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_PROPOSAL_POLL_MS = 60000;

function stripTrailingSlash(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end--;
  return s.slice(0, end);
}

/**
 * Resolve the memory config from the secret store. `Pick<'get'>` so callers
 * (and tests) only need the read half. Returns sqlite-only whenever flashback
 * isn't fully configured — a misconfigured remote never crashes the boot.
 */
export function loadMemoryConfig(secrets: Pick<SecretStore, 'get'>): MemoryConfig {
  const url = secrets.get(FLASHBACK_NS, 'url')?.trim();
  const token = secrets.get(FLASHBACK_NS, 'token')?.trim();
  const rawMode = (secrets.get(FLASHBACK_NS, 'mode') ?? '').trim().toLowerCase();

  if (rawMode && rawMode !== 'sqlite' && rawMode !== 'flashback' && rawMode !== 'dual') {
    logger.warn('memory.bad-mode', { mode: rawMode, using: 'sqlite' });
    return { mode: 'sqlite' };
  }
  if (!url || !token) {
    if (rawMode && rawMode !== 'sqlite') {
      logger.warn('memory.remote-unconfigured', { mode: rawMode, using: 'sqlite' });
    }
    return { mode: 'sqlite' };
  }
  // Credentials present: honor the stored mode, defaulting to the safe dual-run.
  let mode: MemoryMode = 'dual';
  if (rawMode === 'sqlite' || rawMode === 'flashback') mode = rawMode;
  if (mode === 'sqlite') return { mode };
  const timeoutMs = Number(secrets.get(FLASHBACK_NS, 'timeout_ms') ?? '') || DEFAULT_TIMEOUT_MS;
  const proposalPollMs = Number(secrets.get(FLASHBACK_NS, 'proposal_poll_ms') ?? '') || DEFAULT_PROPOSAL_POLL_MS;
  return { mode, flashback: { endpoint: stripTrailingSlash(url), token, timeoutMs, proposalPollMs } };
}
