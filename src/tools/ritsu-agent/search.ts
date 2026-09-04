/**
 * Web-search backends for the WebSearch tool.
 *
 * One shape, several providers: a self-hosted searxng (no key, full privacy)
 * or a hosted API. The provider and its endpoint are operator settings; an API
 * key, where one is needed, is a secret. Agents never see either — they call
 * WebSearch and get result lines back.
 *
 * Adding a provider is a request builder plus a response mapper; nothing above
 * this file changes.
 */
import { asString } from '../../util/cast.js';
import { stripTrailingSlashes } from '../../util/path-utils.js';

export const SEARCH_PROVIDERS = ['searxng', 'brave', 'tavily', 'serper'] as const;
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number];

/** Providers that authenticate with a key. searxng is self-hosted and takes
 *  a URL instead, which is why it is the one that works with nothing bought. */
export const KEYED_PROVIDERS: readonly SearchProvider[] = ['brave', 'tavily', 'serper'];

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchConfig {
  provider: SearchProvider;
  /** searxng only: the instance base URL. */
  url?: string;
  /** Hosted providers: the API key. */
  apiKey?: string;
}

export function isSearchProvider(v: string): v is SearchProvider {
  return (SEARCH_PROVIDERS as readonly string[]).includes(v);
}

/** Human-readable reason the config can't be used, or null when it can. */
export function searchConfigError(cfg: SearchConfig): string | null {
  if (cfg.provider === 'searxng') {
    return cfg.url?.trim() ? null : 'searxng selected but no instance URL is set';
  }
  return cfg.apiKey?.trim() ? null : `${cfg.provider} selected but no API key is set`;
}

interface BuiltRequest {
  url: string;
  init: RequestInit;
  /** Maps the provider's JSON body to the common hit shape. */
  parse: (json: unknown) => SearchHit[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> =>
  (v && typeof v === 'object' ? v as Record<string, unknown> : {});

export function buildSearchRequest(cfg: SearchConfig, query: string, limit: number, userAgent: string): BuiltRequest {
  const jsonHeaders = { 'Content-Type': 'application/json', 'User-Agent': userAgent };
  switch (cfg.provider) {
    case 'searxng': {
      const base = stripTrailingSlashes(cfg.url ?? '');
      return {
        url: `${base}/search?` + new URLSearchParams({ q: query, format: 'json' }).toString(),
        init: { headers: { 'User-Agent': userAgent } },
        parse: json => rows(obj(json).results).map(r => ({
          title: str(obj(r).title), url: str(obj(r).url), snippet: str(obj(r).content),
        })),
      };
    }
    case 'brave': {
      const params = new URLSearchParams({ q: query, count: String(limit) });
      return {
        url: `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
        init: {
          headers: {
            Accept: 'application/json',
            'X-Subscription-Token': cfg.apiKey ?? '',
            'User-Agent': userAgent,
          },
        },
        // Brave nests the organic results under web.results.
        parse: json => rows(obj(obj(json).web).results).map(r => ({
          title: str(obj(r).title), url: str(obj(r).url), snippet: str(obj(r).description),
        })),
      };
    }
    case 'tavily':
      return {
        url: 'https://api.tavily.com/search',
        init: {
          method: 'POST',
          headers: { ...jsonHeaders, Authorization: `Bearer ${cfg.apiKey ?? ''}` },
          body: JSON.stringify({ query, max_results: limit }),
        },
        parse: json => rows(obj(json).results).map(r => ({
          title: str(obj(r).title), url: str(obj(r).url), snippet: str(obj(r).content),
        })),
      };
    case 'serper':
      return {
        url: 'https://google.serper.dev/search',
        init: {
          method: 'POST',
          headers: { ...jsonHeaders, 'X-API-KEY': cfg.apiKey ?? '' },
          body: JSON.stringify({ q: query, num: limit }),
        },
        parse: json => rows(obj(json).organic).map(r => ({
          title: str(obj(r).title), url: str(obj(r).link), snippet: str(obj(r).snippet),
        })),
      };
    default: {
      const _exhaustive: never = cfg.provider;
      throw new Error(`unknown search provider: ${asString(_exhaustive)}`);
    }
  }
}

/** Render hits the way the model reads them. Kept here so every provider
 *  produces identical output and a swap is invisible to the agent. */
export function formatHits(hits: SearchHit[]): string {
  if (hits.length === 0) return '(no results)';
  return hits.map((h, i) => {
    const title = (h.title || '(no title)').replace(/\s+/g, ' ').trim();
    const url = h.url || '(no url)';
    const snippet = h.snippet.replace(/\s+/g, ' ').trim().slice(0, 280);
    return `[${i + 1}] ${title} — ${url}${snippet ? '\n    ' + snippet : ''}`;
  }).join('\n');
}
