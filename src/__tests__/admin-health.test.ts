import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../db.js';
import { ApiKeyStore } from '../auth/api-key-store.js';
import { _resetKeyCacheForTests } from '../util/secret-crypto.js';
import { runHealthChecks, type HealthDeps } from '../admin/health.js';

function fakeSecrets(values: Record<string, string>): HealthDeps['secrets'] {
  return { get: (ns, name) => values[`${ns}:${name}`] ?? null };
}

const okDefStore: HealthDeps['defStore'] = { list: async () => [] };

/** fetch stub: records URLs + auth headers, answers per-URL status. */
function fakeFetch(seen: Array<{ url: string; auth: string | null }>, statusFor: (url: string) => number): typeof fetch {
  return async (url, init) => {
    const u = url instanceof Request ? url.url : String(url);
    const h = new Headers(init?.headers);
    seen.push({ url: u, auth: h.get('authorization') ?? h.get('x-api-key') });
    return new Response('{}', { status: statusFor(u), headers: { 'content-type': 'application/json' } });
  };
}

describe('runHealthChecks (System → Health)', () => {
  let apiKeys: ApiKeyStore;

  beforeEach(() => {
    process.env.RITSU_MASTER_KEY = randomBytes(32).toString('base64');
    _resetKeyCacheForTests();
    apiKeys = new ApiKeyStore(openDatabase(':memory:'));
  });

  it('probes each active key against its provider model-list endpoint', async () => {
    apiKeys.mint('ant-key', 'anthropic', 'sk-ant-x');
    apiKeys.mint('xai-key', 'xai', 'xai-x');
    apiKeys.mint('custom-key', 'custom', 'whatever');
    const seen: Array<{ url: string; auth: string | null }> = [];
    const { checks } = await runHealthChecks({
      defStore: okDefStore, apiKeys, secrets: fakeSecrets({}),
      fetchImpl: fakeFetch(seen, () => 200), claudeCredsPath: '/nonexistent',
    });

    assert.ok(seen.some(s => s.url === 'https://api.anthropic.com/v1/models' && s.auth === 'sk-ant-x'));
    assert.ok(seen.some(s => s.url === 'https://api.x.ai/v1/models' && s.auth === 'Bearer xai-x'));
    const custom = checks.find(c => c.label.includes('custom'))!;
    assert.equal(custom.status, 'skip');
    assert.equal(checks.filter(c => c.group === 'providers' && c.status === 'ok').length, 2);
  });

  it('maps auth rejection and unreachability to fail with detail', async () => {
    apiKeys.mint('bad-key', 'openai', 'sk-bad');
    const { checks } = await runHealthChecks({
      defStore: okDefStore, apiKeys,
      secrets: fakeSecrets({ 'flashback:url': 'http://localhost:9', 'flashback:token': 't' }),
      fetchImpl: async (url: string | URL | Request) => {
        const u = url instanceof Request ? url.url : String(url);
        if (u.includes('localhost:9')) throw new Error('connect ECONNREFUSED');
        return new Response('{}', { status: 401 });
      },
      claudeCredsPath: '/nonexistent',
    });
    assert.equal(checks.find(c => c.id.startsWith('key-'))?.status, 'fail');
    assert.equal(checks.find(c => c.id.startsWith('key-'))?.detail, 'HTTP 401');
    const fb = checks.find(c => c.id === 'flashback')!;
    assert.equal(fb.status, 'fail');
    assert.match(fb.detail ?? '', /ECONNREFUSED/);
  });

  it('reports unconfigured connectors as skip and partial config as fail', async () => {
    const { checks } = await runHealthChecks({
      defStore: okDefStore, apiKeys,
      secrets: fakeSecrets({ 'email:imap_host': 'mail.example.com' }),
      fetchImpl: fakeFetch([], () => 200), claudeCredsPath: '/nonexistent',
    });
    assert.equal(checks.find(c => c.id === 'twitter')?.status, 'skip');
    assert.equal(checks.find(c => c.id === 'flashback')?.status, 'skip');
    const email = checks.find(c => c.id === 'email')!;
    assert.equal(email.status, 'fail');
    assert.match(email.detail ?? '', /partially configured/);
    assert.equal(checks.find(c => c.id === 'claude-session')?.status, 'fail');
  });

  it('appends /v1/models to a litellm url that lacks the /v1 suffix', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    await runHealthChecks({
      defStore: okDefStore, apiKeys,
      secrets: fakeSecrets({ 'litellm:url': 'http://localhost:4000' }),
      fetchImpl: fakeFetch(seen, () => 200), claudeCredsPath: '/nonexistent',
    });
    assert.ok(seen.some(s => s.url === 'http://localhost:4000/v1/models'));
  });
});
