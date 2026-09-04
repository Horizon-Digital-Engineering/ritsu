/**
 * Native network tools for the ritsu-agent runtime: WebFetch + WebSearch.
 *
 * WebSearch: runs against the operator-selected provider (see search.ts) —
 * a self-hosted searxng, or a hosted API. Configured in the admin UI; an
 * agent may override the searxng URL via `provider_options.searxng_url`.
 * Returns top-N results with title / url / snippet.
 *
 * WebFetch: HTTP GET with manually-followed redirects + size cap. SSRF
 * guard (see ssrf-guard.ts) rejects URLs / redirects / resolved IPs that
 * point into private ranges, cloud metadata, loopback, etc. Closes DNS
 * rebinding via a custom undici dispatcher that validates at connect
 * time. Operator escape hatch:
 * `RITSU_WEBFETCH_ALLOW_PRIVATE_HOSTS=internal.example,docs.internal`.
 */
import type { RaTool } from '../../model/ritsu-agent/types.js';
import { checkToolUse } from '../permissions.js';
import { logger } from '../../util/log.js';
import { asString } from '../../util/cast.js';
import { safeFetch, validateUrl } from './ssrf-guard.js';
import {
  buildSearchRequest, formatHits, searchConfigError, type SearchConfig,
} from './search.js';

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_MAX_BYTES = 200 * 1024;     // 200KB content cap
const SEARCH_MAX_RESULTS = 10;
// Generic UA — explicitly identifying ourselves as ritsu in outbound
// requests is a recon gift to anyone fingerprinting LAN probes. Matches
// the major-version of a recent Firefox so requests pattern-match what
// non-headless traffic looks like.
const WEBFETCH_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
export interface NetworkOptions {
  /** Operator-configured provider + credential, resolved by the caller. When
   *  absent, WebSearch reports that it is unconfigured instead of guessing. */
  search?: SearchConfig;
  /** Per-agent override for the searxng URL, applied over `search.url`. */
  searxng_url?: string;
  /** Optional custom fetch (tests inject). */
  fetchImpl?: typeof fetch;
}

export function buildNetworkTools(opts: NetworkOptions = {}): RaTool[] {
  // The per-agent searxng override wins over the operator default, so one
  // agent can point at a different instance without changing the global.
  const search: SearchConfig | undefined = opts.search
    ? { ...opts.search, ...(opts.searxng_url ? { url: opts.searxng_url } : {}) }
    : (opts.searxng_url ? { provider: 'searxng', url: opts.searxng_url } : undefined);
  const searchError = search ? searchConfigError(search) : 'WebSearch is not configured';
  const fetchImpl = opts.fetchImpl ?? fetch;

  return [
    {
      name: 'WebFetch',
      description:
        'HTTP GET a URL and return the response body as text. Follows redirects (max 5). ' +
        'Response is capped at 200KB. Good for fetching documentation, status pages, public APIs.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['url'],
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL.' },
        },
      },
      handler: async (args) => {
        const url = asString(args.url).trim();
        if (!url) return 'error: url required';
        // Stage 1: cheap URL-level validation. Runs even for the test path
        // (fetchImpl injection) so that "only http(s) URLs" is enforced
        // regardless of which fetch backend the caller wired up.
        const v = validateUrl(url);
        if (!v.ok) return `error: ${v.reason}`;
        // Permission gate is the same shared module; WebFetch is the "network"
        // category which currently returns ok unconditionally. Routing through
        // it keeps the audit point consistent.
        const auth = checkToolUse('WebFetch', { url }, []);
        if (!auth.ok) return `denied: ${auth.reason}`;
        try {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
          // safeFetch enforces IP-range + DNS-rebinding protections and
          // follows redirects manually with per-hop re-validation. Tests
          // can still inject `fetchImpl` to bypass the dispatcher for
          // unit-test setups that don't (or can't) stand up a real
          // loopback server.
          const headers = { 'User-Agent': WEBFETCH_USER_AGENT };
          const doFetch = opts.fetchImpl
            ? () => opts.fetchImpl!(url, { signal: ctl.signal, redirect: 'follow', headers })
            : () => safeFetch(url, { signal: ctl.signal, headers });
          const res = await doFetch().finally(() => clearTimeout(timer));
          if (!res.ok) return `error: HTTP ${res.status} ${res.statusText}`;
          const ct = res.headers.get('content-type') ?? '';
          const reader = res.body?.getReader();
          if (!reader) {
            // Fallback: text() if streaming not available
            const text = await res.text();
            return formatFetchBody(text, ct);
          }
          const chunks: Uint8Array[] = [];
          let total = 0;
          while (total < FETCH_MAX_BYTES) {
            // reader is the body's ReadableStream<Uint8Array>; the spec types
            // value as `any` (ReadableStream is generic), so narrow at the
            // boundary.
            const read = await reader.read() as { value: Uint8Array | undefined; done: boolean };
            if (read.done || !read.value) break;
            chunks.push(read.value);
            total += read.value.byteLength;
          }
          // Make sure we drain or cancel so the connection releases.
          try { await reader.cancel(); } catch { /* ignore */ }
          const truncated = total >= FETCH_MAX_BYTES;
          const bytes = Buffer.concat(chunks.map(c => Buffer.from(c)));
          const body = bytes.toString('utf8');
          logger.debug('ra.network.webfetch', { url, bytes: total, truncated });
          return formatFetchBody(body, ct, truncated);
        } catch (err) {
          const e = err as Error;
          return e.name === 'AbortError'
            ? `error: fetch timed out after ${FETCH_TIMEOUT_MS}ms`
            : `error: ${e.message}`;
        }
      },
    },
    {
      name: 'WebSearch',
      description:
        'Web search. Returns the top results as `[N] title — url — snippet` lines. ' +
        'The backend is operator-configured; results look the same whichever it is.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Search query.' },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max results (default 10).' },
        },
      },
      handler: async (args) => {
        const query = asString(args.query).trim();
        if (!query) return 'error: query required';
        if (!search || searchError) return `error: WebSearch unavailable — ${searchError}`;
        const limit = typeof args.limit === 'number' ? args.limit : SEARCH_MAX_RESULTS;
        const auth = checkToolUse('WebSearch', {}, []);
        if (!auth.ok) return `denied: ${auth.reason}`;
        try {
          const req = buildSearchRequest(search, query, limit, WEBFETCH_USER_AGENT);
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
          const res = await fetchImpl(req.url, { ...req.init, signal: ctl.signal })
            .finally(() => clearTimeout(timer));
          // Name the provider in the error: with several possible backends,
          // "HTTP 401" alone doesn't say which credential is wrong.
          if (!res.ok) return `error: ${search.provider} HTTP ${res.status} ${res.statusText}`;
          const hits = req.parse(await res.json()).slice(0, limit);
          logger.debug('ra.network.websearch', { provider: search.provider, query, count: hits.length });
          return formatHits(hits);
        } catch (err) {
          const e = err as Error;
          return e.name === 'AbortError'
            ? `error: search timed out after ${FETCH_TIMEOUT_MS}ms`
            : `error: ${e.message}`;
        }
      },
    },
  ];
}

function formatFetchBody(body: string, contentType: string, truncated = false): string {
  const ctTag = contentType ? `[${contentType}]\n` : '';
  const trunc = truncated ? `\n--- truncated at ${FETCH_MAX_BYTES} bytes ---` : '';
  return ctTag + body + trunc;
}
