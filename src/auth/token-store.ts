import { randomBytes, createHash } from 'node:crypto';
import type { Db } from '../db.js';

export type TokenScope = 'mcp' | 'admin';

export interface MintedToken {
  /** Full token, shown to the operator exactly once. */
  token: string;
  id: number;
  name: string;
  scope: TokenScope;
  prefix: string;
  created_at: number;
  /** Unix seconds; null = never expires. */
  expires_at: number | null;
}

export interface TokenRow {
  id: number;
  name: string;
  scope: TokenScope;
  token_prefix: string;
  created_at: number;
  last_used_at: number | null;
  use_count: number;
  revoked_at: number | null;
  expires_at: number | null;
}

export interface TokenUsageRow {
  ts: number;
  tool: string;
  agent_id: string | null;
  status: number;
}

/**
 * Per-scope visual prefix. Lets an operator tell at a glance whether a token
 * leaked from a clipboard / log / chat is admin-tier or MCP-tier without
 * having to look it up in the DB.
 *   rt_   MCP token (tools/data)
 *   rat_  ritsu admin token (operator surface)
 *
 * The prefix is purely cosmetic — the real scope enforcement is the
 * `scope` column on `mcp_tokens` enforced by verify(token, scope).
 */
const PREFIX: Record<TokenScope, string> = { mcp: 'rt_', admin: 'rat_' };
const ALL_PREFIXES = Object.values(PREFIX);

function generateToken(scope: TokenScope): string {
  // 24 bytes = 32 base64url chars (no padding); plenty of entropy.
  return PREFIX[scope] + randomBytes(24).toString('base64url');
}

function hasKnownPrefix(token: string): boolean {
  return ALL_PREFIXES.some(p => token.startsWith(p));
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Bearer tokens for the ritsu auth surface. Plaintext returned once at
 * mint and never readable again — only the sha256 hash is stored.
 *
 * Tokens carry a `scope`:
 *   - 'mcp'   — authorises calls against /mcp (the agent tool surface)
 *   - 'admin' — authorises calls against /admin/* (the operator UI + CRUD)
 *
 * Each scope is checked independently; an mcp-scoped token cannot reach
 * /admin/* and vice versa.
 */
export class TokenStore {
  constructor(private readonly db: Db) {}

  mint(name: string, scope: TokenScope = 'mcp', ttlSeconds?: number | null): MintedToken {
    if (!name.trim()) throw new Error('token name required');
    if (ttlSeconds !== undefined && ttlSeconds !== null && (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)) {
      throw new Error('ttl_seconds must be a positive integer or omitted');
    }
    const token = generateToken(scope);
    const hash = hashToken(token);
    const prefix = token.slice(0, PREFIX[scope].length + 8);
    const expiresAt = ttlSeconds ? Math.floor(Date.now() / 1000) + Math.floor(ttlSeconds) : null;
    const r = this.db
      .prepare(
        `INSERT INTO mcp_tokens (name, token_hash, token_prefix, scope, expires_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(name.trim(), hash, prefix, scope, expiresAt);
    const id = Number(r.lastInsertRowid);
    const created_at = this.db
      .prepare('SELECT created_at FROM mcp_tokens WHERE id = ?')
      .get(id) as { created_at: number };
    return { token, id, name: name.trim(), scope, prefix, created_at: created_at.created_at, expires_at: expiresAt };
  }

  /**
   * Look up a token by its plaintext value. Returns row if active AND the
   * scope matches. Returns null if missing, revoked, or wrong scope.
   *
   * Prefix check accepts ANY known prefix — for back-compat with bootstrap
   * admin tokens minted before the rat_ prefix existed (they're still
   * rt_-prefixed in the wild). The scope filter in the SQL WHERE is the
   * actual security boundary; prefix is cosmetic.
   */
  verify(token: string, scope: TokenScope = 'mcp'): { id: number; name: string; scope: TokenScope } | null {
    if (!hasKnownPrefix(token)) return null;
    const hash = hashToken(token);
    // Expiry is checked in SQL so the verify path stays one round-trip.
    // NULL expires_at = never expires (legacy behavior preserved).
    const row = this.db
      .prepare(
        `SELECT id, name, scope FROM mcp_tokens
         WHERE token_hash = ?
           AND revoked_at IS NULL
           AND scope = ?
           AND (expires_at IS NULL OR expires_at > strftime('%s','now'))`,
      )
      .get(hash, scope) as { id: number; name: string; scope: TokenScope } | undefined;
    return row ?? null;
  }

  /** Bump usage counters and append an audit row. */
  recordUsage(token_id: number, tool: string, agent_id: string | null, status: number): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE mcp_tokens
           SET last_used_at = strftime('%s','now'), use_count = use_count + 1
           WHERE id = ?`,
        )
        .run(token_id);
      this.db
        .prepare(
          `INSERT INTO mcp_token_usage (token_id, tool, agent_id, status) VALUES (?, ?, ?, ?)`,
        )
        .run(token_id, tool, agent_id, status);
    });
    tx();
  }

  /** List tokens. Optional scope filter. */
  list(scope?: TokenScope): TokenRow[] {
    const sql = scope
      ? `SELECT id, name, scope, token_prefix, created_at, last_used_at, use_count, revoked_at, expires_at
         FROM mcp_tokens WHERE scope = ? ORDER BY created_at DESC`
      : `SELECT id, name, scope, token_prefix, created_at, last_used_at, use_count, revoked_at, expires_at
         FROM mcp_tokens ORDER BY created_at DESC`;
    return (scope
      ? this.db.prepare(sql).all(scope)
      : this.db.prepare(sql).all()) as TokenRow[];
  }

  revoke(id: number): boolean {
    const r = this.db
      .prepare(`UPDATE mcp_tokens SET revoked_at = strftime('%s','now') WHERE id = ? AND revoked_at IS NULL`)
      .run(id);
    return r.changes > 0;
  }

  delete(id: number): boolean {
    const r = this.db
      .prepare(`DELETE FROM mcp_tokens WHERE id = ? AND revoked_at IS NOT NULL`)
      .run(id);
    return r.changes > 0;
  }

  recentUsage(token_id: number, limit = 50): TokenUsageRow[] {
    return this.db
      .prepare(
        `SELECT ts, tool, agent_id, status FROM mcp_token_usage
         WHERE token_id = ?
         ORDER BY ts DESC, id DESC
         LIMIT ?`,
      )
      .all(token_id, limit) as TokenUsageRow[];
  }

  hasAnyActive(scope?: TokenScope): boolean {
    const sql = scope
      ? `SELECT 1 FROM mcp_tokens WHERE revoked_at IS NULL AND scope = ? LIMIT 1`
      : `SELECT 1 FROM mcp_tokens WHERE revoked_at IS NULL LIMIT 1`;
    const r = scope
      ? this.db.prepare(sql).get(scope)
      : this.db.prepare(sql).get();
    return !!r;
  }
}
