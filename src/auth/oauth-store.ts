import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db.js';

/**
 * MCP-spec OAuth 2.1 server (RFC 7591 DCR + 9728 PRM + 8414 ASM + 8707 audience).
 *
 * Public clients only — every flow requires PKCE (S256), no client_secret
 * is ever issued or accepted. Access + refresh tokens are random opaque
 * strings, stored only as sha256 hashes.
 *
 * Lifetimes:
 *   - authz code:      5 minutes, single-use (consumed_at)
 *   - access token:    1 hour
 *   - refresh token:   30 days, rotated on every exchange
 */

const ACCESS_TTL_S  = 60 * 60;          // 1h
const REFRESH_TTL_S = 60 * 60 * 24 * 30; // 30d
const CODE_TTL_S    = 60 * 5;            // 5m
const AUTHZ_REQ_TTL_S = 60 * 10;          // 10m — operator window to approve consent

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function rand(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time string equality (defence in depth — bypass to lookup is already hashed). */
function safeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export interface OAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: 'none';
  scope: string;
  software_id?: string;
  software_version?: string;
  created_at: number;
  revoked_at: number | null;
}

export interface RegisterClientInput {
  client_name?: string;
  redirect_uris: string[];
  scope?: string;
  software_id?: string;
  software_version?: string;
}

export interface MintedCode {
  code: string;
  expires_in: number;
}

export interface MintedTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
}

export interface AccessTokenInfo {
  client_id: string;
  scope: string;
  resource: string;
  expires_at: number;
}

export interface AuthzCodeInfo {
  client_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  resource: string;
}

export interface AuthorizeRequestParams {
  client_id: string;
  redirect_uri: string;
  scope: string;
  state: string | undefined;
  code_challenge: string;
  code_challenge_method: 'S256';
  resource: string;
}

export interface AuthorizeRequestRecord extends AuthorizeRequestParams {
  request_id: string;
  expires_at: number;
}

export class OAuthStore {
  constructor(private readonly db: Db) {}

  // ---- clients (DCR — RFC 7591) ----------------------------------------

  registerClient(input: RegisterClientInput): OAuthClient {
    const client_id = 'mcp_' + randomBytes(16).toString('hex');
    const redirect_uris = input.redirect_uris;
    const scope = (input.scope ?? 'mcp').trim() || 'mcp';
    const row = this.db
      .prepare(
        `INSERT INTO oauth_clients
          (client_id, client_name, redirect_uris, scope, software_id, software_version)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        client_id,
        (input.client_name ?? 'unnamed mcp client').slice(0, 200),
        JSON.stringify(redirect_uris),
        scope,
        input.software_id ?? null,
        input.software_version ?? null,
      );
    if (row.changes !== 1) throw new Error('failed to insert oauth_client');
    return this.getClient(client_id)!;
  }

  getClient(client_id: string): OAuthClient | null {
    const row = this.db
      .prepare(
        `SELECT client_id, client_name, redirect_uris, grant_types, response_types,
                token_endpoint_auth_method, scope, software_id, software_version,
                created_at, revoked_at
         FROM oauth_clients WHERE client_id = ? AND revoked_at IS NULL`,
      )
      .get(client_id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      client_id: row.client_id as string,
      client_name: row.client_name as string,
      redirect_uris: JSON.parse(row.redirect_uris as string) as string[],
      grant_types: JSON.parse(row.grant_types as string) as string[],
      response_types: JSON.parse(row.response_types as string) as string[],
      token_endpoint_auth_method: 'none',
      scope: row.scope as string,
      software_id: (row.software_id as string | null) ?? undefined,
      software_version: (row.software_version as string | null) ?? undefined,
      created_at: row.created_at as number,
      revoked_at: (row.revoked_at as number | null) ?? null,
    };
  }

  listClients(): OAuthClient[] {
    const rows = this.db
      .prepare(
        `SELECT client_id, client_name, redirect_uris, grant_types, response_types,
                token_endpoint_auth_method, scope, software_id, software_version,
                created_at, revoked_at
         FROM oauth_clients ORDER BY created_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(row => ({
      client_id: row.client_id as string,
      client_name: row.client_name as string,
      redirect_uris: JSON.parse(row.redirect_uris as string) as string[],
      grant_types: JSON.parse(row.grant_types as string) as string[],
      response_types: JSON.parse(row.response_types as string) as string[],
      token_endpoint_auth_method: 'none',
      scope: row.scope as string,
      software_id: (row.software_id as string | null) ?? undefined,
      software_version: (row.software_version as string | null) ?? undefined,
      created_at: row.created_at as number,
      revoked_at: (row.revoked_at as number | null) ?? null,
    }));
  }

  revokeClient(client_id: string): boolean {
    const tx = this.db.transaction(() => {
      const r = this.db
        .prepare(`UPDATE oauth_clients SET revoked_at = strftime('%s','now') WHERE client_id = ? AND revoked_at IS NULL`)
        .run(client_id);
      if (r.changes > 0) {
        // Cascade: revoke all live tokens for this client.
        this.db
          .prepare(`UPDATE oauth_access_tokens SET revoked_at = strftime('%s','now') WHERE client_id = ? AND revoked_at IS NULL`)
          .run(client_id);
        this.db
          .prepare(`UPDATE oauth_refresh_tokens SET revoked_at = strftime('%s','now') WHERE client_id = ? AND revoked_at IS NULL`)
          .run(client_id);
      }
      return r.changes > 0;
    });
    return tx();
  }

  // ---- authorize requests (GET-set, POST-consume; CSRF + state binding) -

  /**
   * Persist an in-flight authorize request. Returned `request_id` is the
   * only field the consent form carries back to us; everything else
   * (PKCE, redirect_uri, scope, resource, state) is reloaded from the DB
   * on POST. That removes the attack where a malicious page submits the
   * consent form with a different code_challenge than the GET rendered.
   *
   * Caller is responsible for having already validated the params via
   * `validateAuthorize` — this method does NO cross-checking, it just
   * stores.
   */
  createAuthorizeRequest(params: AuthorizeRequestParams): AuthorizeRequestRecord {
    const request_id = rand(24);
    const expires_at = Math.floor(Date.now() / 1000) + AUTHZ_REQ_TTL_S;
    this.db
      .prepare(
        `INSERT INTO oauth_authorize_requests
          (request_id, client_id, redirect_uri, scope, state, code_challenge,
           code_challenge_method, resource, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request_id,
        params.client_id,
        params.redirect_uri,
        params.scope,
        params.state ?? null,
        params.code_challenge,
        params.code_challenge_method,
        params.resource,
        expires_at,
      );
    return { ...params, request_id, expires_at };
  }

  /**
   * Single-use lookup. Marks the row consumed and returns its params if
   * still live. Returns null if the request_id is unknown, expired, or
   * already consumed — the consent POST handler should treat all three
   * the same way (refuse to mint).
   */
  consumeAuthorizeRequest(request_id: string): AuthorizeRequestRecord | null {
    const now = Math.floor(Date.now() / 1000);
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT request_id, client_id, redirect_uri, scope, state,
                  code_challenge, code_challenge_method, resource,
                  expires_at, consumed_at
             FROM oauth_authorize_requests
            WHERE request_id = ?`,
        )
        .get(request_id) as Record<string, unknown> | undefined;
      if (!row) return null;
      if ((row.consumed_at as number | null) !== null) return null;
      if ((row.expires_at as number) < now) return null;
      this.db
        .prepare(`UPDATE oauth_authorize_requests SET consumed_at = ? WHERE request_id = ?`)
        .run(now, request_id);
      return {
        request_id: row.request_id as string,
        client_id: row.client_id as string,
        redirect_uri: row.redirect_uri as string,
        scope: row.scope as string,
        state: (row.state as string | null) ?? undefined,
        code_challenge: row.code_challenge as string,
        code_challenge_method: row.code_challenge_method as 'S256',
        resource: row.resource as string,
        expires_at: row.expires_at as number,
      };
    });
    return tx();
  }

  // ---- authorization codes ---------------------------------------------

  /**
   * Mint an authorization code after the user has approved consent. Caller
   * must have already validated that redirect_uri belongs to client.
   */
  mintAuthzCode(args: {
    client_id: string;
    redirect_uri: string;
    scope: string;
    code_challenge: string;
    code_challenge_method: 'S256';
    resource: string;
  }): MintedCode {
    const code = rand(32);
    const expires_at = Math.floor(Date.now() / 1000) + CODE_TTL_S;
    this.db
      .prepare(
        `INSERT INTO oauth_authz_codes
          (code_hash, client_id, redirect_uri, scope, code_challenge, code_challenge_method, resource, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sha(code),
        args.client_id,
        args.redirect_uri,
        args.scope,
        args.code_challenge,
        args.code_challenge_method,
        args.resource,
        expires_at,
      );
    return { code, expires_in: CODE_TTL_S };
  }

  /**
   * Consume an authz code. Verifies (constant time):
   *   - exists & not previously consumed & not expired
   *   - client_id matches
   *   - redirect_uri matches
   *   - PKCE verifier matches code_challenge
   * Returns the bound metadata (scope, resource) on success.
   * Returns null on any mismatch — caller responds with invalid_grant.
   */
  consumeAuthzCode(args: {
    code: string;
    client_id: string;
    redirect_uri: string;
    code_verifier: string;
  }): AuthzCodeInfo | null {
    const code_hash = sha(args.code);
    const row = this.db
      .prepare(
        `SELECT client_id, redirect_uri, scope, code_challenge, code_challenge_method, resource, expires_at, consumed_at
         FROM oauth_authz_codes WHERE code_hash = ?`,
      )
      .get(code_hash) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (row.consumed_at) return null;
    if ((row.expires_at as number) < Math.floor(Date.now() / 1000)) return null;
    if (!safeEq(row.client_id as string, args.client_id)) return null;
    if (!safeEq(row.redirect_uri as string, args.redirect_uri)) return null;

    // PKCE S256: base64url(sha256(code_verifier)) === code_challenge
    const expected = createHash('sha256').update(args.code_verifier).digest('base64url');
    if (!safeEq(expected, row.code_challenge as string)) return null;

    this.db
      .prepare(`UPDATE oauth_authz_codes SET consumed_at = strftime('%s','now') WHERE code_hash = ?`)
      .run(code_hash);

    return {
      client_id: row.client_id as string,
      redirect_uri: row.redirect_uri as string,
      scope: row.scope as string,
      code_challenge: row.code_challenge as string,
      resource: row.resource as string,
    };
  }

  // ---- access + refresh tokens -----------------------------------------

  mintTokens(args: { client_id: string; scope: string; resource: string }): MintedTokens {
    const access_token  = rand(32);
    const refresh_token = rand(32);
    const now = Math.floor(Date.now() / 1000);
    const access_expires  = now + ACCESS_TTL_S;
    const refresh_expires = now + REFRESH_TTL_S;
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO oauth_access_tokens (token_hash, client_id, scope, resource, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(sha(access_token), args.client_id, args.scope, args.resource, access_expires);
      this.db
        .prepare(
          `INSERT INTO oauth_refresh_tokens (token_hash, client_id, scope, resource, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(sha(refresh_token), args.client_id, args.scope, args.resource, refresh_expires);
    });
    tx();
    return { access_token, refresh_token, expires_in: ACCESS_TTL_S, scope: args.scope };
  }

  /**
   * Verify an access token. Returns binding metadata if live, else null.
   * Caller (MCP middleware) is responsible for checking the resource
   * matches its own canonical URI (audience validation, RFC 8707).
   */
  verifyAccessToken(token: string): AccessTokenInfo | null {
    const row = this.db
      .prepare(
        `SELECT client_id, scope, resource, expires_at FROM oauth_access_tokens
         WHERE token_hash = ? AND revoked_at IS NULL`,
      )
      .get(sha(token)) as Record<string, unknown> | undefined;
    if (!row) return null;
    if ((row.expires_at as number) < Math.floor(Date.now() / 1000)) return null;
    return {
      client_id: row.client_id as string,
      scope: row.scope as string,
      resource: row.resource as string,
      expires_at: row.expires_at as number,
    };
  }

  /**
   * Exchange a refresh token for a new access+refresh pair. Per OAuth 2.1
   * for public clients, refresh tokens MUST rotate (the old one is revoked
   * and replaced). Returns null if refresh is missing, expired, revoked,
   * or client_id mismatch.
   */
  rotateRefresh(args: { refresh_token: string; client_id: string }): MintedTokens | null {
    const old_hash = sha(args.refresh_token);
    const row = this.db
      .prepare(
        `SELECT client_id, scope, resource, expires_at, revoked_at FROM oauth_refresh_tokens
         WHERE token_hash = ?`,
      )
      .get(old_hash) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (row.revoked_at) {
      // Reuse of a rotated token — kill the whole client chain (token reuse detection per OAuth 2.1 §4.3.1).
      this.db
        .prepare(`UPDATE oauth_refresh_tokens SET revoked_at = strftime('%s','now') WHERE client_id = ? AND revoked_at IS NULL`)
        .run(row.client_id);
      this.db
        .prepare(`UPDATE oauth_access_tokens SET revoked_at = strftime('%s','now') WHERE client_id = ? AND revoked_at IS NULL`)
        .run(row.client_id);
      return null;
    }
    if ((row.expires_at as number) < Math.floor(Date.now() / 1000)) return null;
    if (!safeEq(row.client_id as string, args.client_id)) return null;

    const minted = this.mintTokens({
      client_id: row.client_id as string,
      scope: row.scope as string,
      resource: row.resource as string,
    });
    // Mark old as rotated.
    this.db
      .prepare(`UPDATE oauth_refresh_tokens SET revoked_at = strftime('%s','now'), rotated_to = ? WHERE token_hash = ?`)
      .run(sha(minted.refresh_token), old_hash);
    return minted;
  }

  /** Per-client token counts (active = not-revoked AND not-expired). Drives
   *  the admin UI's "X access / Y refresh" column on the OAuth Clients tab. */
  countTokens(client_id: string): { access_active: number; access_total: number; refresh_active: number; refresh_total: number } {
    const now = Math.floor(Date.now() / 1000);
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM oauth_access_tokens WHERE client_id = ?1) AS access_total,
        (SELECT COUNT(*) FROM oauth_access_tokens WHERE client_id = ?1 AND revoked_at IS NULL AND expires_at >= ?2) AS access_active,
        (SELECT COUNT(*) FROM oauth_refresh_tokens WHERE client_id = ?1) AS refresh_total,
        (SELECT COUNT(*) FROM oauth_refresh_tokens WHERE client_id = ?1 AND revoked_at IS NULL AND expires_at >= ?2) AS refresh_active
    `).get(client_id, now) as { access_total: number; access_active: number; refresh_total: number; refresh_active: number };
    return row;
  }

  /** Active/issued token rows for a single client, most-recent first.
   *  Used by the admin UI's per-client detail view. Returns hashes only
   *  (token plaintext is never persisted — sha256 of plaintext is the row
   *  key, just like the legacy rt_* tokens). */
  listTokensForClient(client_id: string, limit = 50): Array<{ kind: 'access' | 'refresh'; token_hash: string; scope: string; resource: string; expires_at: number; revoked_at: number | null; created_at: number }> {
    const access = this.db.prepare(`
      SELECT 'access' AS kind, token_hash, scope, resource, expires_at, revoked_at, created_at
        FROM oauth_access_tokens WHERE client_id = ?
       ORDER BY created_at DESC LIMIT ?
    `).all(client_id, limit) as Array<{ kind: 'access'; token_hash: string; scope: string; resource: string; expires_at: number; revoked_at: number | null; created_at: number }>;
    const refresh = this.db.prepare(`
      SELECT 'refresh' AS kind, token_hash, scope, resource, expires_at, revoked_at, created_at
        FROM oauth_refresh_tokens WHERE client_id = ?
       ORDER BY created_at DESC LIMIT ?
    `).all(client_id, limit) as Array<{ kind: 'refresh'; token_hash: string; scope: string; resource: string; expires_at: number; revoked_at: number | null; created_at: number }>;
    return [...access, ...refresh].sort((a, b) => b.created_at - a.created_at).slice(0, limit);
  }

  /** Sweep expired codes + tokens. Safe to call periodically. */
  gc(): { codes: number; access: number; refresh: number } {
    const now = Math.floor(Date.now() / 1000);
    const codes = this.db
      .prepare(`DELETE FROM oauth_authz_codes WHERE expires_at < ?`)
      .run(now).changes;
    const access = this.db
      .prepare(`DELETE FROM oauth_access_tokens WHERE expires_at < ? AND revoked_at IS NOT NULL`)
      .run(now).changes;
    const refresh = this.db
      .prepare(`DELETE FROM oauth_refresh_tokens WHERE expires_at < ? AND revoked_at IS NOT NULL`)
      .run(now).changes;
    return { codes, access, refresh };
  }
}
