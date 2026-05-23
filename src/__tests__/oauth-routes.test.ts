/**
 * HTTP-level integration tests for the OAuth 2.1 routes mounted by
 * mountOAuthRoutes(). Stand up a minimal Express app with an in-memory
 * SQLite store and exercise the routes via fetch against an ephemeral
 * port — same shape a real client (claude.ai web's "Add custom
 * connector", Claude Desktop Connectors) would hit.
 *
 * Coverage focus: contract regressions on the spec endpoints
 * (RFC 7591 DCR, RFC 9728 PRM, RFC 8414 ASM, RFC 8707 audience binding,
 * PKCE S256, refresh-token rotation, revocation cascade).
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import express from 'express';
import { type Server, type AddressInfo } from 'node:net';
import { createInMemoryDb, type Db } from '../db.js';
import { mountOAuthRoutes } from '../auth/oauth-routes.js';
import { OAuthStore } from '../auth/oauth-store.js';
import { TokenStore } from '../auth/token-store.js';

const SCHEMA = `
CREATE TABLE oauth_clients (
  client_id                  TEXT PRIMARY KEY,
  client_name                TEXT NOT NULL,
  redirect_uris              TEXT NOT NULL,
  grant_types                TEXT NOT NULL DEFAULT '["authorization_code","refresh_token"]',
  response_types             TEXT NOT NULL DEFAULT '["code"]',
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  scope                      TEXT NOT NULL DEFAULT 'mcp',
  software_id                TEXT,
  software_version           TEXT,
  created_at                 INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  revoked_at                 INTEGER
);
CREATE TABLE oauth_authorize_requests (
  request_id            TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL REFERENCES oauth_clients(client_id),
  redirect_uri          TEXT NOT NULL,
  scope                 TEXT NOT NULL,
  state                 TEXT,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL CHECK (code_challenge_method IN ('S256')),
  resource              TEXT NOT NULL,
  expires_at            INTEGER NOT NULL,
  consumed_at           INTEGER,
  created_at            INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE TABLE oauth_authz_codes (
  code_hash             TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL REFERENCES oauth_clients(client_id),
  redirect_uri          TEXT NOT NULL,
  scope                 TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL CHECK (code_challenge_method IN ('S256')),
  resource              TEXT NOT NULL,
  state_snapshot        TEXT,
  expires_at            INTEGER NOT NULL,
  consumed_at           INTEGER,
  created_at            INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE TABLE oauth_access_tokens (
  token_hash   TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL REFERENCES oauth_clients(client_id),
  scope        TEXT NOT NULL,
  resource     TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE TABLE oauth_refresh_tokens (
  token_hash   TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL REFERENCES oauth_clients(client_id),
  scope        TEXT NOT NULL,
  resource     TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  rotated_to   TEXT,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE TABLE mcp_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  scope        TEXT NOT NULL DEFAULT 'mcp',
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  last_used_at INTEGER,
  use_count    INTEGER NOT NULL DEFAULT 0,
  revoked_at   INTEGER,
  expires_at   INTEGER
);
`;

const PUBLIC_URL = 'https://test.example.com:9443';

let server: Server;
let baseUrl: string;
let db: Db;
let oauth: OAuthStore;
let tokens: TokenStore;
let adminToken: string;

/** PKCE S256: code_challenge = base64url(sha256(code_verifier)). */
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

before(async () => {
  db = createInMemoryDb();
  db.exec(SCHEMA);
  oauth = new OAuthStore(db);
  tokens = new TokenStore(db);
  const minted = tokens.mint('test-admin', 'admin');
  adminToken = minted.token;

  const app = express();
  app.use(express.json());
  mountOAuthRoutes(app, { oauth, tokens, publicUrl: PUBLIC_URL });

  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
    server.on('error', reject);
  });
});

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  // Each test starts with fresh clients / codes / tokens. mcp_tokens stays
  // populated (admin token survives) — the test admin token is re-used.
  db.exec(`
    DELETE FROM oauth_refresh_tokens;
    DELETE FROM oauth_access_tokens;
    DELETE FROM oauth_authz_codes;
    DELETE FROM oauth_authorize_requests;
    DELETE FROM oauth_clients;
  `);
});

// ---- Discovery (RFC 9728 PRM, RFC 8414 ASM) -----------------------------

describe('OAuth discovery endpoints', () => {
  it('GET /.well-known/oauth-protected-resource returns RFC 9728 PRM document', async () => {
    const r = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    assert.equal(r.status, 200);
    const j = await r.json() as Record<string, unknown>;
    assert.equal(j.resource, `${PUBLIC_URL}/mcp`);
    assert.deepEqual(j.authorization_servers, [PUBLIC_URL]);
    assert.deepEqual(j.bearer_methods_supported, ['header']);
    assert.deepEqual(j.scopes_supported, ['mcp']);
  });

  it('GET /.well-known/oauth-authorization-server returns RFC 8414 ASM document', async () => {
    const r = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    assert.equal(r.status, 200);
    const j = await r.json() as Record<string, unknown>;
    assert.equal(j.issuer, PUBLIC_URL);
    assert.equal(j.authorization_endpoint, `${PUBLIC_URL}/oauth/authorize`);
    assert.equal(j.token_endpoint, `${PUBLIC_URL}/oauth/token`);
    assert.equal(j.registration_endpoint, `${PUBLIC_URL}/oauth/register`);
    assert.deepEqual(j.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(j.grant_types_supported, ['authorization_code', 'refresh_token']);
    assert.deepEqual(j.token_endpoint_auth_methods_supported, ['none']);
  });
});

// ---- Dynamic Client Registration (RFC 7591) -----------------------------

describe('POST /oauth/register (RFC 7591 DCR)', () => {
  it('registers a client with https redirect_uris', async () => {
    const r = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'test-client',
        redirect_uris: ['https://example.com/callback'],
        scope: 'mcp',
      }),
    });
    assert.equal(r.status, 201);
    const j = await r.json() as Record<string, unknown>;
    assert.ok(typeof j.client_id === 'string' && j.client_id.startsWith('mcp_'));
    assert.equal(j.client_name, 'test-client');
    assert.deepEqual(j.redirect_uris, ['https://example.com/callback']);
    assert.equal(j.token_endpoint_auth_method, 'none');
  });

  it('registers a client with loopback redirect_uris (http allowed)', async () => {
    const r = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'desktop-client',
        redirect_uris: ['http://127.0.0.1:7777/callback'],
      }),
    });
    assert.equal(r.status, 201);
  });

  it('rejects a non-loopback http redirect_uri', async () => {
    const r = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'bad-client',
        redirect_uris: ['http://example.com/callback'],
      }),
    });
    assert.equal(r.status, 400);
    const j = await r.json() as Record<string, unknown>;
    assert.equal(j.error, 'invalid_redirect_uri');
  });

  it('rejects a malformed redirect_uri', async () => {
    const r = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'bad-client',
        redirect_uris: ['not-a-url'],
      }),
    });
    assert.equal(r.status, 400);
  });

  it('rejects a body missing redirect_uris', async () => {
    const r = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'bad-client' }),
    });
    assert.equal(r.status, 400);
  });
});

// ---- Authorize (GET — render consent page) ------------------------------

describe('GET /oauth/authorize', () => {
  let clientId: string;

  beforeEach(async () => {
    const r = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'consent-test',
        redirect_uris: ['https://example.com/callback'],
      }),
    });
    const j = await r.json() as { client_id: string };
    clientId = j.client_id;
  });

  it('renders the consent HTML for a well-formed request', async () => {
    const { challenge } = pkcePair();
    const qs = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://example.com/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'mcp',
    });
    const r = await fetch(`${baseUrl}/oauth/authorize?${qs.toString()}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /text\/html/);
    const body = await r.text();
    assert.match(body, /Authorize MCP client/);
    assert.match(body, /consent-test/);
  });

  it('rejects response_type other than code', async () => {
    const { challenge } = pkcePair();
    const qs = new URLSearchParams({
      response_type: 'token',
      client_id: clientId,
      redirect_uri: 'https://example.com/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const r = await fetch(`${baseUrl}/oauth/authorize?${qs.toString()}`);
    assert.equal(r.status, 400);
    const body = await r.text();
    assert.match(body, /unsupported_response_type/);
  });

  it('rejects unknown client_id', async () => {
    const { challenge } = pkcePair();
    const qs = new URLSearchParams({
      response_type: 'code',
      client_id: 'mcp_nonexistent',
      redirect_uri: 'https://example.com/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const r = await fetch(`${baseUrl}/oauth/authorize?${qs.toString()}`);
    assert.equal(r.status, 400);
    const body = await r.text();
    assert.match(body, /invalid_client/);
  });

  it('rejects missing PKCE code_challenge', async () => {
    const qs = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://example.com/callback',
    });
    const r = await fetch(`${baseUrl}/oauth/authorize?${qs.toString()}`);
    assert.equal(r.status, 400);
    const body = await r.text();
    assert.match(body, /code_challenge required/);
  });

  it('rejects code_challenge_method other than S256', async () => {
    const { challenge } = pkcePair();
    const qs = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://example.com/callback',
      code_challenge: challenge,
      code_challenge_method: 'plain',
    });
    const r = await fetch(`${baseUrl}/oauth/authorize?${qs.toString()}`);
    assert.equal(r.status, 400);
    const body = await r.text();
    assert.match(body, /code_challenge_method must be S256/);
  });

  it('rejects an unregistered redirect_uri', async () => {
    const { challenge } = pkcePair();
    const qs = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://attacker.com/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const r = await fetch(`${baseUrl}/oauth/authorize?${qs.toString()}`);
    assert.equal(r.status, 400);
    const body = await r.text();
    assert.match(body, /redirect_uri not registered/);
  });
});

// ---- Authorize (POST — consent submission) -----------------------------

describe('POST /oauth/authorize', () => {
  let clientId: string;
  let challenge: string;

  // verifier deliberately not captured — these tests only exercise the
  // consent flow up to the redirect; the matching `verifier` for the
  // PKCE exchange is generated inside the token-grant describe below.

  beforeEach(async () => {
    const r = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'consent-post-test',
        redirect_uris: ['https://example.com/callback'],
      }),
    });
    const j = await r.json() as { client_id: string };
    clientId = j.client_id;
    challenge = pkcePair().challenge;
  });

  /** Helper: drive the full consent round-trip. Does a GET first to
   *  obtain a fresh request_id (the new flow puts PKCE / redirect / scope
   *  / resource in server-side state, not the POST body), then POSTs with
   *  the request_id + decision + admin_token. Returns the raw Response so
   *  callers can inspect status / Location header. */
  async function obtainRequestId(query: Record<string, string>): Promise<string | null> {
    const r = await fetch(`${baseUrl}/oauth/authorize?${new URLSearchParams(query).toString()}`);
    if (r.status !== 200) return null;
    const html = await r.text();
    const m = html.match(/name="request_id" value="([^"]+)"/);
    return m ? m[1] : null;
  }

  async function postConsent(fields: Record<string, string>): Promise<Response> {
    // Split fields: GET params go to GET, decision/admin_token to POST.
    const getParams: Record<string, string> = {};
    const postParams: Record<string, string> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'decision' || k === 'admin_token') postParams[k] = v;
      else getParams[k] = v;
    }
    const requestId = await obtainRequestId(getParams);
    if (requestId) postParams.request_id = requestId;
    return fetch(`${baseUrl}/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(postParams).toString(),
      redirect: 'manual',
    });
  }

  it('with valid admin token + decision=approve → 302 to redirect_uri with code', async () => {
    const r = await postConsent({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://example.com/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'mcp',
      state: 'opaque-state',
      decision: 'approve',
      admin_token: adminToken,
    });
    assert.equal(r.status, 302);
    const loc = r.headers.get('location')!;
    const u = new URL(loc);
    assert.equal(u.origin + u.pathname, 'https://example.com/callback');
    assert.ok(u.searchParams.get('code'));
    assert.equal(u.searchParams.get('state'), 'opaque-state');
  });

  it('with decision=deny → 302 to redirect_uri with error=access_denied', async () => {
    const r = await postConsent({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://example.com/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      decision: 'deny',
      admin_token: adminToken,
      state: 'denied-state',
    });
    assert.equal(r.status, 302);
    const u = new URL(r.headers.get('location')!);
    assert.equal(u.searchParams.get('error'), 'access_denied');
    assert.equal(u.searchParams.get('state'), 'denied-state');
  });

  it('rejects missing admin_token', async () => {
    const r = await postConsent({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://example.com/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      decision: 'approve',
    });
    assert.equal(r.status, 400);
    const body = await r.text();
    assert.match(body, /admin_token required/);
  });

  it('rejects an invalid admin_token with 401 + consent re-rendered', async () => {
    const r = await postConsent({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://example.com/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      decision: 'approve',
      admin_token: 'rat_invalid_token_value',
    });
    assert.equal(r.status, 401);
    const body = await r.text();
    assert.match(body, /Authorize MCP client/);
    assert.match(body, /invalid admin token/);
  });

  it('rejects an mcp-scope token used as admin_token', async () => {
    const mcpOnly = tokens.mint('test-mcp', 'mcp').token;
    const r = await postConsent({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://example.com/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      decision: 'approve',
      admin_token: mcpOnly,
    });
    assert.equal(r.status, 401);
  });

  it('refuses a POST whose request_id does not exist (replay / forged)', async () => {
    const r = await fetch(`${baseUrl}/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        request_id: 'this_was_never_issued',
        decision: 'approve',
        admin_token: adminToken,
      }).toString(),
      redirect: 'manual',
    });
    assert.equal(r.status, 400);
    assert.match(await r.text(), /expired or already used/);
  });

  it('refuses a second POST with the same request_id (single-use)', async () => {
    // Get a request_id and use it once (approve) — second attempt must
    // refuse, even with the same admin_token.
    const requestId = await obtainRequestId({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://example.com/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    assert.ok(requestId);
    const a = await fetch(`${baseUrl}/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ request_id: requestId ?? '', decision: 'approve', admin_token: adminToken }).toString(),
      redirect: 'manual',
    });
    assert.equal(a.status, 302);
    const b = await fetch(`${baseUrl}/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ request_id: requestId ?? '', decision: 'approve', admin_token: adminToken }).toString(),
      redirect: 'manual',
    });
    assert.equal(b.status, 400);
  });

  it('rejects a POST with a cross-origin Origin header', async () => {
    const requestId = await obtainRequestId({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://example.com/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const r = await fetch(`${baseUrl}/oauth/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://attacker.example',
      },
      body: new URLSearchParams({ request_id: requestId ?? '', decision: 'approve', admin_token: adminToken }).toString(),
      redirect: 'manual',
    });
    assert.equal(r.status, 403);
  });
});

// ---- Token endpoint — authorization_code grant (RFC 8707) --------------

describe('POST /oauth/token authorization_code', () => {
  let clientId: string;
  let challenge: string;
  let verifier: string;
  let code: string;
  const resource = `${PUBLIC_URL}/mcp`;

  beforeEach(async () => {
    // 1. Register a client.
    const reg = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'token-test',
        redirect_uris: ['https://example.com/cb'],
      }),
    });
    clientId = (await reg.json() as { client_id: string }).client_id;
    // 2. Compute PKCE pair.
    const p = pkcePair();
    challenge = p.challenge;
    verifier = p.verifier;
    // 3. GET consent to obtain a request_id, then POST approve with it.
    const getR = await fetch(`${baseUrl}/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://example.com/cb',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'mcp',
      resource,
    }).toString()}`);
    const html = await getR.text();
    const requestId = html.match(/name="request_id" value="([^"]+)"/)?.[1] ?? '';
    const consent = await fetch(`${baseUrl}/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        request_id: requestId,
        decision: 'approve',
        admin_token: adminToken,
      }).toString(),
      redirect: 'manual',
    });
    const u = new URL(consent.headers.get('location')!);
    code = u.searchParams.get('code')!;
  });

  it('exchanges a fresh code for an access + refresh token pair', async () => {
    const r = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://example.com/cb',
        client_id: clientId,
        code_verifier: verifier,
      }),
    });
    assert.equal(r.status, 200);
    const j = await r.json() as Record<string, unknown>;
    assert.equal(j.token_type, 'Bearer');
    assert.ok(typeof j.access_token === 'string');
    assert.ok(typeof j.refresh_token === 'string');
    assert.ok(typeof j.expires_in === 'number');
    assert.equal(j.scope, 'mcp');
  });

  it('rejects a second use of the same code (single-use enforcement)', async () => {
    const first = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code, redirect_uri: 'https://example.com/cb',
        client_id: clientId, code_verifier: verifier,
      }),
    });
    assert.equal(first.status, 200);
    const second = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code, redirect_uri: 'https://example.com/cb',
        client_id: clientId, code_verifier: verifier,
      }),
    });
    assert.equal(second.status, 400);
    const j = await second.json() as Record<string, unknown>;
    assert.equal(j.error, 'invalid_grant');
  });

  it('rejects a wrong code_verifier (PKCE mismatch)', async () => {
    const wrong = randomBytes(32).toString('base64url');
    const r = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code, redirect_uri: 'https://example.com/cb',
        client_id: clientId, code_verifier: wrong,
      }),
    });
    assert.equal(r.status, 400);
    const j = await r.json() as Record<string, unknown>;
    assert.equal(j.error, 'invalid_grant');
  });

  it('rejects a redirect_uri that differs from the authorize-time value', async () => {
    const r = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code, redirect_uri: 'https://example.com/cb',
        client_id: 'mcp_other',
        code_verifier: verifier,
      }),
    });
    assert.equal(r.status, 400);
  });

  it('rejects a resource mismatch on the token request (RFC 8707)', async () => {
    const r = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code, redirect_uri: 'https://example.com/cb',
        client_id: clientId, code_verifier: verifier,
        resource: 'https://different.example.com/mcp',
      }),
    });
    assert.equal(r.status, 400);
    const j = await r.json() as Record<string, unknown>;
    assert.equal(j.error, 'invalid_target');
  });
});

// ---- Token endpoint — refresh_token grant ------------------------------

describe('POST /oauth/token refresh_token', () => {
  let clientId: string;
  let refreshToken: string;

  beforeEach(async () => {
    // Register + grant: get a refresh token to rotate.
    const reg = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'refresh-test',
        redirect_uris: ['https://example.com/cb'],
      }),
    });
    clientId = (await reg.json() as { client_id: string }).client_id;
    const { challenge, verifier } = pkcePair();
    // GET first to get request_id, then POST consent.
    const getR = await fetch(`${baseUrl}/oauth/authorize?${new URLSearchParams({
      response_type: 'code', client_id: clientId,
      redirect_uri: 'https://example.com/cb',
      code_challenge: challenge, code_challenge_method: 'S256',
      scope: 'mcp',
    }).toString()}`);
    const requestId = (await getR.text()).match(/name="request_id" value="([^"]+)"/)?.[1] ?? '';
    const consent = await fetch(`${baseUrl}/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        request_id: requestId,
        decision: 'approve', admin_token: adminToken,
      }).toString(),
      redirect: 'manual',
    });
    const code = new URL(consent.headers.get('location')!).searchParams.get('code')!;
    const tokRes = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code, redirect_uri: 'https://example.com/cb',
        client_id: clientId, code_verifier: verifier,
      }),
    });
    refreshToken = (await tokRes.json() as { refresh_token: string }).refresh_token;
  });

  it('rotates a refresh token: returns a new pair', async () => {
    const r = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    });
    assert.equal(r.status, 200);
    const j = await r.json() as Record<string, unknown>;
    assert.ok(typeof j.access_token === 'string');
    assert.ok(typeof j.refresh_token === 'string');
    assert.notEqual(j.refresh_token, refreshToken);
  });

  it('rejects reuse of an already-rotated refresh token', async () => {
    const first = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    });
    assert.equal(first.status, 200);
    const second = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    });
    assert.equal(second.status, 400);
    const j = await second.json() as Record<string, unknown>;
    assert.equal(j.error, 'invalid_grant');
  });

  it('rejects a refresh token used with the wrong client_id', async () => {
    const r = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: 'mcp_someone_else',
      }),
    });
    assert.equal(r.status, 400);
  });
});

// ---- Token endpoint — error paths --------------------------------------

describe('POST /oauth/token error paths', () => {
  it('rejects a missing grant_type', async () => {
    const r = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
    const j = await r.json() as Record<string, unknown>;
    assert.equal(j.error, 'invalid_request');
  });

  it('rejects an unsupported grant_type', async () => {
    const r = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password' }),
    });
    assert.equal(r.status, 400);
    const j = await r.json() as Record<string, unknown>;
    assert.equal(j.error, 'unsupported_grant_type');
  });

  it('sets Cache-Control: no-store on token responses', async () => {
    const r = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'unknown' }),
    });
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('pragma'), 'no-cache');
  });
});

// Suppress unused-import warning when running this file standalone.
void createHmac;
