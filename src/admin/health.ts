/**
 * Live connectivity checks for System → Health. Read-only probes with short
 * timeouts; details carry HTTP status / error text only, never key material.
 */
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiKeyStore } from '../auth/api-key-store.js';
import type { AgentDefinitionStore } from '../agent-definition-store.js';
import { stripTrailingSlashes } from '../util/path-utils.js';
import { LITELLM_NS } from '../model/ritsu-agent/client.js';
import { SEARCH_NS } from '../tools/ritsu-agent/search-config.js';
import { FLASHBACK_NS } from '../memory/config.js';
import { EMAIL_NS, EMAIL_SECRET_KEYS } from '../connectors/email.js';
import { TWITTER_NS, TWITTER_SECRET_KEYS } from '../connectors/twitter.js';
import { LINKEDIN_NS, LINKEDIN_SECRET_KEYS } from '../connectors/linkedin.js';
import { INGEST_NS } from '../ingestion/extractors.js';

export type HealthStatus = 'ok' | 'fail' | 'skip';

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
  /** Operator settings, for checks whose config is not a secret. */
  settings?: { get(key: string): string | null };
  defStore: Pick<AgentDefinitionStore, 'list'>;
  apiKeys: Pick<ApiKeyStore, 'list' | 'reveal'>;
  secrets: { get(namespace: string, name: string): string | null };
  fetchImpl?: typeof fetch;
  claudeCredsPath?: string;
  timeoutMs?: number;
}

/** Cheap authenticated endpoints (model lists) — verify key + reachability
 *  without spending tokens. */
const PROVIDER_PROBES: Record<string, (key: string) => { url: string; headers: Record<string, string> }> = {
  anthropic: k => ({ url: 'https://api.anthropic.com/v1/models', headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' } }),
  openai: k => ({ url: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${k}` } }),
  gemini: k => ({ url: 'https://generativelanguage.googleapis.com/v1beta/models', headers: { 'x-goog-api-key': k } }),
  xai: k => ({ url: 'https://api.x.ai/v1/models', headers: { Authorization: `Bearer ${k}` } }),
  openrouter: k => ({ url: 'https://openrouter.ai/api/v1/models', headers: { Authorization: `Bearer ${k}` } }),
};

export async function runHealthChecks(deps: HealthDeps): Promise<{ checks: HealthCheck[]; ran_at: number }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 4000;
  const probe = (url: string, headers: Record<string, string> = {}) => probeHttp(url, headers, fetchImpl, timeoutMs);

  const tasks: Array<Promise<HealthCheck>> = [
    dbCheck(deps.defStore),
    Promise.resolve(claudeCheck(deps.claudeCredsPath)),
    ...deps.apiKeys.list().filter(k => !k.revoked_at).map(k => providerKeyCheck(k.id, k.name, k.provider, deps, probe)),
    litellmProxyCheck(deps.secrets, probe),
    flashbackCheck(deps.secrets, probe),
    searchCheck(deps.settings, deps.secrets, probe),
    ingestCheck(deps.secrets, probe),
    Promise.resolve(configuredCheck('email', 'Email (IMAP/SMTP)', deps.secrets, EMAIL_NS, EMAIL_SECRET_KEYS)),
    Promise.resolve(configuredCheck('twitter', 'X / Twitter', deps.secrets, TWITTER_NS, TWITTER_SECRET_KEYS)),
    Promise.resolve(configuredCheck('linkedin', 'LinkedIn', deps.secrets, LINKEDIN_NS, LINKEDIN_SECRET_KEYS)),
  ];

  const settled = await Promise.allSettled(tasks);
  const checks = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { id: `check-${i}`, label: 'internal', group: 'core' as const, status: 'fail' as const, detail: String(s.reason) },
  );
  return { checks, ran_at: Math.floor(Date.now() / 1000) };
}

async function dbCheck(defStore: HealthDeps['defStore']): Promise<HealthCheck> {
  const t0 = Date.now();
  try {
    const defs = await defStore.list();
    return { id: 'db', label: 'Database (SQLite)', group: 'core', status: 'ok', latency_ms: Date.now() - t0, detail: `${defs.length} agents` };
  } catch (e) {
    return { id: 'db', label: 'Database (SQLite)', group: 'core', status: 'fail', detail: (e as Error).message };
  }
}

function claudeCheck(credsPath?: string): HealthCheck {
  const p = credsPath ?? join(homedir(), '.claude', '.credentials.json');
  return existsSync(p)
    ? { id: 'claude-token', label: 'Claude session (direct runtime)', group: 'core', status: 'ok' }
    : { id: 'claude-token', label: 'Claude session (direct runtime)', group: 'core', status: 'fail', detail: 'credentials missing — run `claude login` as the service user' };
}

async function providerKeyCheck(
  id: number,
  name: string,
  provider: string,
  deps: HealthDeps,
  probe: (url: string, headers?: Record<string, string>) => Promise<ProbeResult>,
): Promise<HealthCheck> {
  const base = { id: `key-${id}`, label: `${name} (${provider})`, group: 'providers' as const };
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

async function litellmProxyCheck(secrets: HealthDeps['secrets'], probe: ProbeFn): Promise<HealthCheck> {
  const base = { id: 'litellm-proxy', label: 'LiteLLM proxy', group: 'connectors' as const };
  if (!secrets.get(LITELLM_NS, 'url')?.trim()) return { ...base, status: 'skip', detail: 'not configured' };
  const key = secrets.get(LITELLM_NS, 'api_key')?.trim();
  return { ...base, ...(await probe(litellmModelsUrl(secrets), key ? { Authorization: `Bearer ${key}` } : {})) };
}

async function flashbackCheck(secrets: HealthDeps['secrets'], probe: ProbeFn): Promise<HealthCheck> {
  const base = { id: 'flashback', label: 'Flashback (memory)', group: 'connectors' as const };
  const url = secrets.get(FLASHBACK_NS, 'url')?.trim();
  if (!url) return { ...base, status: 'skip', detail: 'not configured' };
  const token = secrets.get(FLASHBACK_NS, 'token')?.trim();
  return { ...base, ...(await probe(`${stripTrailingSlashes(url)}/health`, token ? { Authorization: `Bearer ${token}` } : {})) };
}

/** Only searxng is probeable: it is a URL we host. The hosted providers would
 *  need a billable query to verify, so they report configured-or-not. */
async function searchCheck(settings: HealthDeps['settings'], secrets: HealthDeps['secrets'], probe: ProbeFn): Promise<HealthCheck> {
  const base = { id: 'search', label: 'Web search', group: 'connectors' as const };
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

async function ingestCheck(secrets: HealthDeps['secrets'], probe: ProbeFn): Promise<HealthCheck> {
  const base = { id: 'ingest', label: 'Ingest / vision model', group: 'connectors' as const };
  const endpoint = secrets.get(INGEST_NS, 'endpoint')?.trim();
  if (!endpoint) return { ...base, status: 'skip', detail: 'not configured' };
  const key = secrets.get(INGEST_NS, 'api_key')?.trim();
  return { ...base, ...(await probe(v1ModelsUrl(endpoint), key ? { Authorization: `Bearer ${key}` } : {})) };
}

/** Connectors without a cheap safe probe (IMAP handshake, rate-limited or
 *  scope-limited vendor APIs) report configured/not — no live call. */
function configuredCheck(id: string, label: string, secrets: HealthDeps['secrets'], ns: string, keys: readonly string[]): HealthCheck {
  const set = keys.filter(k => secrets.get(ns, k)?.trim());
  if (set.length === 0) return { id, label, group: 'connectors', status: 'skip', detail: 'not configured' };
  return set.length === keys.length
    ? { id, label, group: 'connectors', status: 'ok', detail: 'configured (no live probe)' }
    : { id, label, group: 'connectors', status: 'fail', detail: `partially configured (${set.length}/${keys.length} keys set)` };
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
