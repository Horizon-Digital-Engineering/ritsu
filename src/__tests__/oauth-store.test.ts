import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { createInMemoryDb, type Db } from '../db.js';
import { OAuthStore } from '../auth/oauth-store.js';

/**
 * Schema duplicated here (vs importing src/db.ts) so tests stay hermetic —
 * src/db.ts is bound to a file path. Keep in sync with the oauth_* tables.
 */
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
`;

function pkce(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

describe('OAuthStore', () => {
  let store: OAuthStore;
  let db: Db;

  beforeEach(() => {
    db = createInMemoryDb();
    db.exec(SCHEMA);
    store = new OAuthStore(db);
  });

  describe('DCR (registerClient)', () => {
    it('issues a unique mcp_* client_id and stores metadata', () => {
      const a = store.registerClient({ client_name: 'foo', redirect_uris: ['https://x.example/cb'] });
      const b = store.registerClient({ client_name: 'bar', redirect_uris: ['https://y.example/cb'] });
      assert.match(a.client_id, /^mcp_[0-9a-f]{32}$/);
      assert.notEqual(b.client_id, a.client_id);
      const got = store.getClient(a.client_id);
      assert.equal(got?.client_name, 'foo');
      assert.deepEqual(got?.redirect_uris, ['https://x.example/cb']);
      assert.equal(got?.token_endpoint_auth_method, 'none');
    });

    it('returns null for unknown or revoked clients', () => {
      const c = store.registerClient({ client_name: 'x', redirect_uris: ['https://x.example/cb'] });
      assert.equal(store.getClient('nope'), null);
      assert.equal(store.revokeClient(c.client_id), true);
      assert.equal(store.getClient(c.client_id), null);
    });
  });

  describe('authorization code flow', () => {
    const verifier = 'a'.repeat(64);
    const challenge = pkce(verifier);
    const redirect = 'https://x.example/cb';
    const resource = 'https://mcp.example/mcp';

    function mintForClient() {
      const client = store.registerClient({ client_name: 'x', redirect_uris: [redirect] });
      const { code } = store.mintAuthzCode({
        client_id: client.client_id,
        redirect_uri: redirect,
        scope: 'mcp',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource,
      });
      return { client, code };
    }

    it('consumes a valid code exactly once with the right verifier', () => {
      const { client, code } = mintForClient();
      const ok = store.consumeAuthzCode({
        code, client_id: client.client_id, redirect_uri: redirect, code_verifier: verifier,
      });
      assert.notEqual(ok, null);
      assert.equal(ok!.scope, 'mcp');
      assert.equal(ok!.resource, resource);
      // Second use should fail.
      const dup = store.consumeAuthzCode({
        code, client_id: client.client_id, redirect_uri: redirect, code_verifier: verifier,
      });
      assert.equal(dup, null);
    });

    it('rejects PKCE mismatch', () => {
      const { client, code } = mintForClient();
      const r = store.consumeAuthzCode({
        code, client_id: client.client_id, redirect_uri: redirect, code_verifier: 'wrong' + verifier,
      });
      assert.equal(r, null);
    });

    it('rejects client_id mismatch', () => {
      const { code } = mintForClient();
      const other = store.registerClient({ client_name: 'y', redirect_uris: [redirect] });
      const r = store.consumeAuthzCode({
        code, client_id: other.client_id, redirect_uri: redirect, code_verifier: verifier,
      });
      assert.equal(r, null);
    });

    it('rejects redirect_uri mismatch', () => {
      const { client, code } = mintForClient();
      const r = store.consumeAuthzCode({
        code, client_id: client.client_id, redirect_uri: 'https://attacker/cb', code_verifier: verifier,
      });
      assert.equal(r, null);
    });
  });

  describe('token issue + verify + audience', () => {
    it('mints a verifiable access token bound to a client + resource', () => {
      const client = store.registerClient({ client_name: 'x', redirect_uris: ['https://x.example/cb'] });
      const tok = store.mintTokens({ client_id: client.client_id, scope: 'mcp', resource: 'https://r/mcp' });
      const info = store.verifyAccessToken(tok.access_token);
      assert.equal(info?.client_id, client.client_id);
      assert.equal(info?.resource, 'https://r/mcp');
      assert.equal(info?.scope, 'mcp');
      // Refresh token is NOT a valid access token.
      assert.equal(store.verifyAccessToken(tok.refresh_token), null);
    });

    it('returns null for unknown / tampered tokens', () => {
      assert.equal(store.verifyAccessToken('garbage'), null);
    });
  });

  describe('refresh rotation', () => {
    it('rotates: each new refresh works, old becomes invalid', () => {
      const client = store.registerClient({ client_name: 'x', redirect_uris: ['https://x.example/cb'] });
      const t1 = store.mintTokens({ client_id: client.client_id, scope: 'mcp', resource: 'https://r/mcp' });
      const t2 = store.rotateRefresh({ refresh_token: t1.refresh_token, client_id: client.client_id });
      assert.notEqual(t2, null);
      assert.notEqual(t2!.access_token, t1.access_token);
      assert.notEqual(t2!.refresh_token, t1.refresh_token);
      // Continue rotating cleanly — the chain works as long as each link is
      // used at most once.
      const t3 = store.rotateRefresh({ refresh_token: t2!.refresh_token, client_id: client.client_id });
      assert.notEqual(t3, null);
      assert.notEqual(t3!.refresh_token, t2!.refresh_token);
    });

    it('reuse of a rotated refresh nukes the whole client chain (token reuse detection)', () => {
      const client = store.registerClient({ client_name: 'x', redirect_uris: ['https://x.example/cb'] });
      const t1 = store.mintTokens({ client_id: client.client_id, scope: 'mcp', resource: 'https://r/mcp' });
      const t2 = store.rotateRefresh({ refresh_token: t1.refresh_token, client_id: client.client_id })!;
      // Attacker replays t1.refresh_token — should not just fail, but also
      // poison the live chain so the legitimate client also notices.
      assert.equal(store.rotateRefresh({ refresh_token: t1.refresh_token, client_id: client.client_id }), null);
      // After reuse-detection, t2's live refresh and access tokens are revoked.
      assert.equal(store.rotateRefresh({ refresh_token: t2.refresh_token, client_id: client.client_id }), null);
      assert.equal(store.verifyAccessToken(t2.access_token), null);
    });

    it('rejects refresh from wrong client', () => {
      const a = store.registerClient({ client_name: 'a', redirect_uris: ['https://a/cb'] });
      const b = store.registerClient({ client_name: 'b', redirect_uris: ['https://b/cb'] });
      const t = store.mintTokens({ client_id: a.client_id, scope: 'mcp', resource: 'https://r/mcp' });
      assert.equal(store.rotateRefresh({ refresh_token: t.refresh_token, client_id: b.client_id }), null);
    });
  });

  describe('revokeClient cascades', () => {
    it('kills all live tokens for the client', () => {
      const client = store.registerClient({ client_name: 'x', redirect_uris: ['https://x.example/cb'] });
      const t = store.mintTokens({ client_id: client.client_id, scope: 'mcp', resource: 'https://r/mcp' });
      assert.notEqual(store.verifyAccessToken(t.access_token), null);
      assert.equal(store.revokeClient(client.client_id), true);
      assert.equal(store.verifyAccessToken(t.access_token), null);
      assert.equal(store.rotateRefresh({ refresh_token: t.refresh_token, client_id: client.client_id }), null);
    });
  });
});
