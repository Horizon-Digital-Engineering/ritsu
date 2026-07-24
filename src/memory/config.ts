/**
 * Env-driven selection for the MemoryBackend seam. Default is `sqlite` —
 * exactly today's behavior, nothing new touches the network. Flipping to
 * `flashback` or `dual` opts an install into the remote store.
 *
 *   MEMORY_BACKEND = sqlite (default) | flashback | dual
 *     sqlite    on-box only; the smart store is never called.
 *     flashback flashback authoritative; sqlite kept as a shadow write.
 *     dual      sqlite authoritative for reads + writes; flashback written
 *               fire-and-forget so an outage there can't touch a turn.
 *
 *   FLASHBACK_URL   base URL of the flashback server (required unless sqlite)
 *   FLASHBACK_TOKEN bearer token for that server   (required unless sqlite)
 *   FLASHBACK_TIMEOUT_MS  per-request timeout, default 5000
 *
 * Parsing is fail-loud on a bad mode but NOT on a missing URL/token — the
 * host decides whether the remote store is actually required, and a
 * misconfigured remote must degrade to sqlite rather than refuse to boot.
 */
export type MemoryMode = 'sqlite' | 'flashback' | 'dual';

export interface MemoryConfig {
  mode: MemoryMode;
  flashback?: {
    endpoint: string;
    token: string;
    timeoutMs: number;
  };
}

const DEFAULT_TIMEOUT_MS = 5000;

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

/**
 * Read the memory config out of an env bag (process.env by default). Returns
 * a fully-resolved config. Throws only on an unrecognized MEMORY_BACKEND;
 * a flashback/dual mode with an absent URL or token yields `flashback:
 * undefined`, which the service treats as "remote unavailable, use sqlite".
 */
export function loadMemoryConfig(env: NodeJS.ProcessEnv = process.env): MemoryConfig {
  const raw = (env.MEMORY_BACKEND ?? 'sqlite').trim().toLowerCase();
  if (raw !== 'sqlite' && raw !== 'flashback' && raw !== 'dual') {
    throw new Error(`MEMORY_BACKEND=${raw}: expected one of sqlite|flashback|dual`);
  }
  const mode: MemoryMode = raw;
  if (mode === 'sqlite') return { mode };

  const endpoint = env.FLASHBACK_URL?.trim();
  const token = env.FLASHBACK_TOKEN?.trim();
  if (!endpoint || !token) {
    // Requested a remote backend without credentials — leave `flashback`
    // unset. The service logs one warning and runs sqlite-only rather than
    // failing every turn against a store it can't reach.
    return { mode };
  }
  const timeoutMs = Number(env.FLASHBACK_TIMEOUT_MS ?? '') || DEFAULT_TIMEOUT_MS;
  return { mode, flashback: { endpoint: stripTrailingSlash(endpoint), token, timeoutMs } };
}
