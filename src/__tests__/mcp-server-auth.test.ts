/**
 * The /mcp auth gate, end to end over real HTTP.
 *
 * This is the surface an unauthenticated caller reaches first, and the module
 * had almost no cover. The specific regression guarded here: `auto` mode used
 * to ask whether an *mcp-scoped* token existed. The token minted on first boot
 * is admin-scoped, so a fully provisioned host — admin UI configured, OAuth
 * stack mounted — kept serving /mcp with auth short-circuited, and only
 * /version admitted it. `auto` now means "open only on a genuinely fresh box".
 */
import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../db.js';
import { TokenStore } from '../auth/token-store.js';
import { OAuthStore } from '../auth/oauth-store.js';
import { SqliteMemoryStore } from '../memory-store.js';
import { SqliteAgentDefinitionStore } from '../agent-definition-store.js';
import { createMcpServer } from '../mcp-server.js';
import type { AgentHost } from '../agent-host.js';
import type { AuthMode } from '../config.js';

const PING = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} });

/** Only `list` is reachable without a tool call, and no test here gets that far. */
const fakeHost = { list: () => [] } as unknown as AgentHost;

interface Harness { baseUrl: string; tokens: TokenStore; close: () => Promise<void> }

async function start(authMode: AuthMode, publicUrl?: string): Promise<Harness> {
  const db = openDatabase(':memory:');
  const tokens = new TokenStore(db);
  const app = createMcpServer({
    host: fakeHost,
    memory: new SqliteMemoryStore(db),
    defStore: new SqliteAgentDefinitionStore(db),
    tokens,
    oauth: new OAuthStore(db),
    authMode,
    bindHost: '127.0.0.1',
    ...(publicUrl ? { publicUrl } : {}),
    // Loopback in a test run shares one IP; keep the limiter out of the way.
    settings: { getNumber: (_k, fallback) => Math.max(fallback, 100_000) },
    version: 'test',
  });
  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    tokens,
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}

const post = (baseUrl: string, auth?: string): Promise<Response> =>
  fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    body: PING,
  });

describe('/mcp auth gate — auto mode', () => {
  let h: Harness;
  before(async () => { h = await start('auto'); });
  after(() => h.close());

  it('is open on a genuinely fresh box (no tokens, no public url)', async () => {
    const res = await post(h.baseUrl);
    assert.notEqual(res.status, 401, 'a fresh box should serve /mcp so the operator can get started');
    await res.body?.cancel();
  });

  it('closes once ANY token exists — including an admin-scoped one', async () => {
    // The bootstrap token is admin-scoped. Scoping the check to 'mcp' left a
    // provisioned host serving /mcp unauthenticated.
    h.tokens.mint('bootstrap', 'admin');
    const res = await post(h.baseUrl);
    assert.equal(res.status, 401, 'an admin token is still a credential; /mcp must close');
  });

  it('an mcp-scoped token closes it too', async () => {
    h.tokens.mint('cli', 'mcp');
    assert.equal((await post(h.baseUrl)).status, 401);
  });
});

describe('/mcp auth gate — auto mode with OAuth configured', () => {
  let h: Harness;
  before(async () => { h = await start('auto', 'https://example.test:9443'); });
  after(() => h.close());

  it('closes on the public url alone, before any token is minted', async () => {
    // Otherwise a configured OAuth stack is mounted and then bypassed.
    assert.equal((await post(h.baseUrl)).status, 401);
  });

  it('401 points spec clients at the resource metadata (RFC 9728)', async () => {
    const res = await post(h.baseUrl);
    const wa = res.headers.get('www-authenticate') ?? '';
    assert.match(wa, /^Bearer realm="ritsu"/);
    assert.match(wa, /resource_metadata="https:\/\/example\.test:9443\/\.well-known\/oauth-protected-resource"/);
  });
});

describe('/mcp auth gate — explicit modes', () => {
  it("'on' requires auth even with no tokens minted", async () => {
    const h = await start('on');
    try { assert.equal((await post(h.baseUrl)).status, 401); }
    finally { await h.close(); }
  });

  it("'off' stays open even once tokens exist", async () => {
    const h = await start('off');
    try {
      h.tokens.mint('cli', 'mcp');
      const res = await post(h.baseUrl);
      assert.notEqual(res.status, 401);
      await res.body?.cancel();
    } finally { await h.close(); }
  });
});

describe('/mcp bearer verification', () => {
  let h: Harness;
  let mcpToken: string;
  let adminToken: string;

  before(async () => {
    h = await start('on');
    mcpToken = h.tokens.mint('cli', 'mcp').token;
    adminToken = h.tokens.mint('ops', 'admin').token;
  });
  after(() => h.close());

  it('accepts a valid mcp-scoped token', async () => {
    const res = await post(h.baseUrl, mcpToken);
    assert.notEqual(res.status, 401);
    await res.body?.cancel();
  });

  it('REFUSES an admin token — admin scope is not MCP scope', async () => {
    assert.equal((await post(h.baseUrl, adminToken)).status, 401);
  });

  it('refuses a made-up token', async () => {
    assert.equal((await post(h.baseUrl, 'rt_nope')).status, 401);
  });

  it('refuses a revoked token', async () => {
    const doomed = h.tokens.mint('temp', 'mcp');
    assert.notEqual((await post(h.baseUrl, doomed.token)).status, 401);
    h.tokens.revoke(doomed.id);
    assert.equal((await post(h.baseUrl, doomed.token)).status, 401);
  });
});

describe('/mcp method surface', () => {
  let h: Harness;
  before(async () => { h = await start('off'); });
  after(() => h.close());

  it('GET and DELETE are 405 — the transport is stateless POST-only', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${h.baseUrl}/mcp`, { method });
      assert.equal(res.status, 405, `${method} /mcp`);
      assert.equal(res.headers.get('allow'), 'POST');
      await res.body?.cancel();
    }
  });
});
