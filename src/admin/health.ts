/**
 * System → Health. The core rows are the parts behind /healthz; the rest are
 * read-only probes with short timeouts whose details carry HTTP status / error
 * text only, never key material.
 */
import type { ApiKeyStore } from '../auth/api-key-store.js';
import { stripTrailingSlashes } from '../util/path-utils.js';
import { LITELLM_NS } from '../model/ritsu-agent/client.js';
import { SEARCH_NS } from '../tools/ritsu-agent/search-config.js';
import { FLASHBACK_NS } from '../memory/config.js';
import { EMAIL_NS, EMAIL_SECRET_KEYS } from '../connectors/email.js';
import { TWITTER_NS, TWITTER_SECRET_KEYS } from '../connectors/twitter.js';
import { LINKEDIN_NS, LINKEDIN_SECRET_KEYS } from '../connectors/linkedin.js';
import { INGEST_NS } from '../ingestion/extractors.js';
import type { Part } from '../health/types.js';

export type HealthStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface HealthCheck {
  id: string;
  label: string;
  group: 'core' | 'providers' | 'connectors';
  status: HealthStatus;
  latency_ms?: number;
  detail?: string;
}

/** Narrow store views so tests can stub them. */
export interface HealthDeps {
  /** The parts behind /healthz, shown as the core rows. */
  parts(): Part[];
  /** Operator settings, for checks whose config is not a secret. */
  settings?: { get(key: string): string | null };
  apiKeys: Pick<ApiKeyStore, 'list' | 'reveal'>;
  secrets: { get(namespace: string, name: string): string | null };
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type Base = Pick<HealthCheck, 'id' | 'label' | 'group'>;

/** Cheap authenticated endpoints (model lists) — verify key + reachability
 *  without spending tokens. */
const PROVIDER_PROBES: Record<string, (key: string) => { url: string; headers: Record<string, string> }> = {
  anthropic: k => ({ url: 'https://api.anthropic.com/v1/models', headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' } }),
  openai: k => ({ url: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${k}` } }),
  gemini: k => ({ url: 'https://generativelanguage.googleapis.com/v1beta/models', headers: { 'x-goog-api-key': k } }),
  xai: k => ({ url: 'https://api.x.ai/v1/models', headers: { Authorization: `Bearer ${k}` } }),
  openrouter: k => ({ url: 'https://openrouter.ai/api/v1/models', headers: { Authorization: `Bearer ${k}` } }),
};

/** A check that throws is its own failed row, not the end of the run. */
async function guarded(base: Base, run: (base: Base) => HealthCheck | Promise<HealthCheck>): Promise<HealthCheck> {
  try {
    return await run(base);
  } catch (e) {
    return { ...base, status: 'fail', detail: (e as Error).message };
  }
}

export async function runHealthChecks(deps: HealthDeps): Promise<{ checks: HealthCheck[]; ran_at: number }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 4000;
  const probe = (url: string, headers: Record<string, string> = {}) => probeHttp(url, headers, fetchImpl, timeoutMs);
  const connector = (id: string, label: string, run: (base: Base) => HealthCheck | Promise<HealthCheck>) =>
    guarded({ id, label, group: 'connectors' }, run);

  const core = deps.parts().map((p): HealthCheck => ({
    id: p.id, label: p.label, group: 'core', status: p.status === 'off' ? 'skip' : p.status, detail: p.note,
  }));
  const probed = await Promise.all([
    ...providerKeyChecks(deps, probe),
    connector('litellm-proxy', 'LiteLLM proxy', b => litellmProxyCheck(b, deps.secrets, probe)),
    connector('flashback', 'Flashback (memory)', b => flashbackCheck(b, deps.secrets, probe)),
    connector('search', 'Web search', b => searchCheck(b, deps.settings, deps.secrets, probe)),
    connector('ingest', 'Ingest / vision model', b => ingestCheck(b, deps.secrets, probe)),
    connector('email', 'Email (IMAP/SMTP)', b => configuredCheck(b, deps.secrets, EMAIL_NS, EMAIL_SECRET_KEYS)),
    connector('twitter', 'X / Twitter', b => configuredCheck(b, deps.secrets, TWITTER_NS, TWITTER_SECRET_KEYS)),
    connector('linkedin', 'LinkedIn', b => configuredCheck(b, deps.secrets, LINKEDIN_NS, LINKEDIN_SECRET_KEYS)),
  ]);
  return { checks: [...core, ...probed], ran_at: Math.floor(Date.now() / 1000) };
}

function providerKeyChecks(deps: HealthDeps, probe: ProbeFn): Array<Promise<HealthCheck>> {
  let keys: ReturnType<HealthDeps['apiKeys']['list']>;
  try {
    keys = deps.apiKeys.list().filter(k => !k.revoked_at);
  } catch (e) {
    return [Promise.resolve({ id: 'api-keys', label: 'API keys', group: 'providers', status: 'fail', detail: (e as Error).message })];
  }
  return keys.map(k => guarded(
    { id: `key-${k.id}`, label: `${k.name} (${k.provider})`, group: 'providers' },
    b => providerKeyCheck(b, k.id, k.provider, deps, probe),
  ));
}

async function providerKeyCheck(base: Base, id: number, provider: string, deps: HealthDeps, probe: ProbeFn): Promise<HealthCheck> {
  if (provider === 'custom') return { ...base, status: 'skip', detail: 'no fixed endpoint to probe' };
  const revealed = deps.apiKeys.reveal(id);
  if (!revealed) return { ...base, status: 'fail', detail: 'key not revealable' };
  if (provider === 'litellm') {
    const url = litellmModelsUrl(deps.secrets);
    return { ...base, ...(await probe(url, { Authorization: `Bearer ${revealed.plaintext}` })) };
  }
  const p = PROVIDER_PROBES[provider];
  if (!p) return { ...base, status: 'skip', detail: `no probe for provider '${provider}'` };
  const { url, headers } = p(revealed.plaintext);
  return { ...base, ...(await probe(url, headers)) };
}

async function litellmProxyCheck(base: Base, secrets: HealthDeps['secrets'], probe: ProbeFn): Promise<HealthCheck> {
  if (!secrets.get(LITELLM_NS, 'url')?.trim()) return { ...base, status: 'skip', detail: 'not configured' };
  const key = secrets.get(LITELLM_NS, 'api_key')?.trim();
  return { ...base, ...(await probe(litellmModelsUrl(secrets), key ? { Authorization: `Bearer ${key}` } : {})) };
}

async function flashbackCheck(base: Base, secrets: HealthDeps['secrets'], probe: ProbeFn): Promise<HealthCheck> {
  const url = secrets.get(FLASHBACK_NS, 'url')?.trim();
  if (!url) return { ...base, status: 'skip', detail: 'not configured' };
  const token = secrets.get(FLASHBACK_NS, 'token')?.trim();
  return { ...base, ...(await probe(`${stripTrailingSlashes(url)}/health`, token ? { Authorization: `Bearer ${token}` } : {})) };
}

/** Only searxng is probeable: it is a URL we host. The hosted providers would
 *  need a billable query to verify, so they report configured-or-not. */
async function searchCheck(base: Base, settings: HealthDeps['settings'], secrets: HealthDeps['secrets'], probe: ProbeFn): Promise<HealthCheck> {
  const provider = settings?.get('search.provider')?.trim();
  if (!provider) return { ...base, status: 'skip', detail: 'not configured' };
  if (provider === 'searxng') {
    const url = settings?.get('search.url')?.trim();
    if (!url) return { ...base, status: 'fail', detail: 'searxng selected but no instance URL set' };
    return { ...base, label: 'Web search (searxng)', ...(await probe(stripTrailingSlashes(url))) };
  }
  const key = secrets.get(SEARCH_NS, 'api_key')?.trim();
  return key
    ? { ...base, label: `Web search (${provider})`, status: 'ok', detail: 'configured (no live probe)' }
    : { ...base, label: `Web search (${provider})`, status: 'fail', detail: 'no API key set' };
}

async function ingestCheck(base: Base, secrets: HealthDeps['secrets'], probe: ProbeFn): Promise<HealthCheck> {
  const endpoint = secrets.get(INGEST_NS, 'endpoint')?.trim();
  if (!endpoint) return { ...base, status: 'skip', detail: 'not configured' };
  const key = secrets.get(INGEST_NS, 'api_key')?.trim();
  return { ...base, ...(await probe(v1ModelsUrl(endpoint), key ? { Authorization: `Bearer ${key}` } : {})) };
}

/** Connectors without a cheap safe probe (IMAP handshake, rate-limited or
 *  scope-limited vendor APIs) report configured/not — no live call. */
function configuredCheck(base: Base, secrets: HealthDeps['secrets'], ns: string, keys: readonly string[]): HealthCheck {
  const set = keys.filter(k => secrets.get(ns, k)?.trim());
  if (set.length === 0) return { ...base, status: 'skip', detail: 'not configured' };
  return set.length === keys.length
    ? { ...base, status: 'ok', detail: 'configured (no live probe)' }
    : { ...base, status: 'fail', detail: `partially configured (${set.length}/${keys.length} keys set)` };
}

function litellmModelsUrl(secrets: HealthDeps['secrets']): string {
  const url = secrets.get(LITELLM_NS, 'url')?.trim() || 'http://localhost:4000/v1';
  return v1ModelsUrl(url);
}

function v1ModelsUrl(endpoint: string): string {
  const base = stripTrailingSlashes(endpoint);
  return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
}

interface ProbeResult { status: HealthStatus; latency_ms: number; detail?: string }
type ProbeFn = (url: string, headers?: Record<string, string>) => Promise<ProbeResult>;

async function probeHttp(url: string, headers: Record<string, string>, fetchImpl: typeof fetch, timeoutMs: number): Promise<ProbeResult> {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers, signal: ctl.signal });
    const latency_ms = Date.now() - t0;
    return res.ok ? { status: 'ok', latency_ms } : { status: 'fail', latency_ms, detail: `HTTP ${res.status}` };
  } catch (e) {
    const err = e as Error;
    return {
      status: 'fail',
      latency_ms: Date.now() - t0,
      detail: err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}
