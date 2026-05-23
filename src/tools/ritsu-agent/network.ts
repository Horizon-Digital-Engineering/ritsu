/**
 * Native network tools for the ritsu-agent runtime: WebFetch + WebSearch.
 *
 * WebSearch: targets a searxng instance (self-hosted, anonymized, no API
 * keys). URL comes from RITSU_SEARXNG_URL or `provider_options.searxng_url`
 * on the agent definition. Returns top-N results with title / url / snippet.
 *
 * WebFetch: HTTP GET with redirect-following + size cap. No egress
 * allowlist enforced yet — agent's tools_allowlist is the gate. A
 * per-agent egress allowlist is a follow-up (project_ritsu_state.md
 * has it on the backlog as "Network egress filtering").
 */
import type { RaTool } from '../../model/ritsu-agent/types.js';
import { checkToolUse } from '../permissions.js';
import { logger } from '../../util/log.js';
import { asString } from '../../util/cast.js';
import { stripTrailingSlashes } from '../../util/path-utils.js';

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_MAX_BYTES = 200 * 1024;     // 200KB content cap
const SEARCH_MAX_RESULTS = 10;
// No default — set RITSU_SEARXNG_URL to point at your searxng instance.
// If unset, the WebSearch tool returns an error rather than fetching from
// a hardcoded host (avoids shipping operator-specific infra in source).
const DEFAULT_SEARXNG_URL = process.env.RITSU_SEARXNG_URL ?? '';

interface SearxngResult {
  title?: string;
  url?: string;
  content?: string;
}

interface SearxngResponse {
  query?: string;
  results?: SearxngResult[];
}

export interface NetworkOptions {
  /** Per-agent override for the searxng URL. Falls back to env / default. */
  searxng_url?: string;
  /** Optional custom fetch (tests inject). */
  fetchImpl?: typeof fetch;
}

export function buildNetworkTools(opts: NetworkOptions = {}): RaTool[] {
  const searxngUrl = stripTrailingSlashes(opts.searxng_url ?? DEFAULT_SEARXNG_URL);
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
        if (!/^https?:\/\//i.test(url)) return 'error: only http(s) URLs are allowed';
        // Permission gate is the same shared module; WebFetch is the "network"
        // category which currently returns ok unconditionally. Routing through
        // it keeps the audit point consistent.
        const auth = checkToolUse('WebFetch', { url }, []);
        if (!auth.ok) return `denied: ${auth.reason}`;
        try {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
          const res = await fetchImpl(url, {
            signal: ctl.signal,
            redirect: 'follow',
            headers: { 'User-Agent': 'ritsu-agent/0.3 (+https://github.com/Horizon-Digital-Engineering/ritsu)' },
          }).finally(() => clearTimeout(timer));
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
        'Web search via a self-hosted searxng instance. Returns the top results as ' +
        '`[N] title — url — snippet` lines. The searxng URL is operator-configured ' +
        '(RITSU_SEARXNG_URL env or per-agent provider_options.searxng_url).',
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
        if (!searxngUrl) return 'error: WebSearch unavailable — set RITSU_SEARXNG_URL';
        const limit = typeof args.limit === 'number' ? args.limit : SEARCH_MAX_RESULTS;
        const auth = checkToolUse('WebSearch', {}, []);
        if (!auth.ok) return `denied: ${auth.reason}`;
        try {
          const url = `${searxngUrl}/search?` + new URLSearchParams({ q: query, format: 'json' }).toString();
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
          const res = await fetchImpl(url, {
            signal: ctl.signal,
            headers: { 'User-Agent': 'ritsu-agent/0.3' },
          }).finally(() => clearTimeout(timer));
          if (!res.ok) return `error: searxng HTTP ${res.status} ${res.statusText}`;
          const json = await res.json() as SearxngResponse;
          const results = (json.results ?? []).slice(0, limit);
          logger.debug('ra.network.websearch', { query, count: results.length });
          if (results.length === 0) return '(no results)';
          return results.map((r, i) => {
            const title = (r.title ?? '(no title)').replace(/\s+/g, ' ').trim();
            const u = r.url ?? '(no url)';
            const snippet = (r.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 280);
            return `[${i + 1}] ${title} — ${u}${snippet ? '\n    ' + snippet : ''}`;
          }).join('\n');
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
