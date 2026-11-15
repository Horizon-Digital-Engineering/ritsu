import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../db.js';
import { ApiKeyStore } from '../auth/api-key-store.js';
import { _resetKeyCacheForTests } from '../util/secret-crypto.js';
import { runHealthChecks, type HealthDeps } from '../admin/health.js';
import type { Part } from '../health/types.js';

function fakeSecrets(values: Record<string, string>): HealthDeps['secrets'] {
  return { get: (ns, name) => values[`${ns}:${name}`] ?? null };
}

const noParts: HealthDeps['parts'] = () => [];

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
      parts: noParts, apiKeys, secrets: fakeSecrets({}),
      fetchImpl: fakeFetch(seen, () => 200),
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
      parts: noParts, apiKeys,
      secrets: fakeSecrets({ 'flashback:url': 'http://localhost:9', 'flashback:token': 't' }),
      fetchImpl: async (url: string | URL | Request) => {
        const u = url instanceof Request ? url.url : String(url);
        if (u.includes('localhost:9')) throw new Error('connect ECONNREFUSED');
        return new Response('{}', { status: 401 });
      },
    });
    assert.equal(checks.find(c => c.id.startsWith('key-'))?.status, 'fail');
    assert.equal(checks.find(c => c.id.startsWith('key-'))?.detail, 'HTTP 401');
    const fb = checks.find(c => c.id === 'flashback')!;
    assert.equal(fb.status, 'fail');
    assert.match(fb.detail ?? '', /ECONNREFUSED/);
  });

  it('reports unconfigured connectors as skip and partial config as fail', async () => {
    const { checks } = await runHealthChecks({
      parts: noParts, apiKeys,
      secrets: fakeSecrets({ 'email:imap_host': 'mail.example.com' }),
      fetchImpl: fakeFetch([], () => 200),
    });
    assert.equal(checks.find(c => c.id === 'twitter')?.status, 'skip');
    assert.equal(checks.find(c => c.id === 'flashback')?.status, 'skip');
    const email = checks.find(c => c.id === 'email')!;
    assert.equal(email.status, 'fail');
    assert.match(email.detail ?? '', /partially configured/);
  });

  it('shows the health parts as the core rows, off as skip and the note as detail', async () => {
    const parts: Part[] = [
      { id: 'database', label: 'Database', status: 'ok', note: 'open, 812 GB free' },
      { id: 'backups', label: 'Backups', status: 'warn', note: 'no daily backup yet' },
      { id: 'mcp', label: 'MCP server', status: 'fail', note: 'not listening' },
      { id: 'voice', label: 'Voice', status: 'off', note: 'turned off' },
    ];
    const { checks } = await runHealthChecks({
      parts: () => parts, apiKeys, secrets: fakeSecrets({}), fetchImpl: fakeFetch([], () => 200),
    });
    const core = checks.filter(c => c.group === 'core');
    assert.deepEqual(core, [
      { id: 'database', label: 'Database', group: 'core', status: 'ok', detail: 'open, 812 GB free' },
      { id: 'backups', label: 'Backups', group: 'core', status: 'warn', detail: 'no daily backup yet' },
      { id: 'mcp', label: 'MCP server', group: 'core', status: 'fail', detail: 'not listening' },
      { id: 'voice', label: 'Voice', group: 'core', status: 'skip', detail: 'turned off' },
    ]);
  });

  it('turns a check that throws into its own failed row and runs the rest', async () => {
    const secrets: HealthDeps['secrets'] = {
      get: (ns) => { if (ns === 'email') throw new Error('unsupported state or unable to authenticate data'); return null; },
    };
    const { checks } = await runHealthChecks({
      parts: noParts, apiKeys, secrets, fetchImpl: fakeFetch([], () => 200),
    });
    const email = checks.find(c => c.id === 'email')!;
    assert.equal(email.status, 'fail');
    assert.equal(email.label, 'Email (IMAP/SMTP)');
    assert.match(email.detail ?? '', /unable to authenticate/);
    assert.equal(checks.find(c => c.id === 'twitter')?.status, 'skip');
    assert.equal(checks.find(c => c.id === 'flashback')?.status, 'skip');
  });

  it('reports a key list that throws as one failed provider row', async () => {
    const broken: HealthDeps['apiKeys'] = {
      list: () => { throw new Error('no such table: api_keys'); },
      reveal: () => null,
    };
    const { checks } = await runHealthChecks({
      parts: noParts, apiKeys: broken, secrets: fakeSecrets({}), fetchImpl: fakeFetch([], () => 200),
    });
    const row = checks.find(c => c.id === 'api-keys')!;
    assert.equal(row.group, 'providers');
    assert.equal(row.status, 'fail');
    assert.equal(checks.find(c => c.id === 'linkedin')?.status, 'skip');
  });

  it('appends /v1/models to a litellm url that lacks the /v1 suffix', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    await runHealthChecks({
      parts: noParts, apiKeys,
      secrets: fakeSecrets({ 'litellm:url': 'http://localhost:4000' }),
      fetchImpl: fakeFetch(seen, () => 200),
    });
    assert.ok(seen.some(s => s.url === 'http://localhost:4000/v1/models'));
  });
});
