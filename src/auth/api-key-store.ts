/**
 * Encrypted-at-rest store for third-party model provider API keys
 * (Anthropic, OpenAI, OpenRouter, etc.) used by the ritsu-agent runtime.
 *
 * Plaintext is returned exactly once at mint time and never again. The DB
 * holds AES-256-GCM ciphertext (via secret-crypto) so a DB leak alone
 * doesn't yield keys. The decrypted value lives only in-process when a
 * dispatcher needs it (looked up by id at call time, not cached).
 */
import type { Db } from '../db.js';
import { encryptSecret, decryptSecret } from '../util/secret-crypto.js';
import { logger } from '../util/log.js';

/** Providers we know about. Open list — adding a new one is a string
 *  literal here + a dispatcher branch later. */
export const API_KEY_PROVIDERS = ['anthropic', 'openai', 'openai-compat', 'litellm'] as const;
export type ApiKeyProvider = (typeof API_KEY_PROVIDERS)[number];

/** Row shape returned to callers — never includes the decrypted key. */
export interface ApiKeyRow {
  id: number;
  name: string;
  provider: ApiKeyProvider;
  /** First 4 chars of the plaintext, for visual identification. Set when
   *  the row is minted; never recomputed. */
  prefix: string;
  created_at: number;
  last_used_at: number | null;
  use_count: number;
  revoked_at: number | null;
}

/** Returned only at mint time — the plaintext is shown to the operator
 *  exactly once. */
export interface MintedApiKey {
  id: number;
  name: string;
  provider: ApiKeyProvider;
  plaintext: string;
  prefix: string;
  created_at: number;
}

interface DbRow {
  id: number;
  name: string;
  provider: string;
  key_enc: string;
  created_at: number;
  last_used_at: number | null;
  use_count: number;
  revoked_at: number | null;
}

/** AAD that binds an api_keys ciphertext to its row id. Identical string
 *  must be used at encrypt + decrypt or the GCM tag fails. The id is the
 *  natural per-row identifier (name + provider can collide on delete+re-
 *  mint); we get it from the auto-increment AFTER an INSERT placeholder. */
function aadFor(id: number): string {
  return `api_key:id=${id}:key_enc`;
}

/** Track the prefix in the encrypted blob's wrapper so list() can show a
 *  visual hint without ever holding plaintext. Format inside key_enc:
 *  `<prefix4>|<enc-payload>` — prefix is 4 plaintext chars, the rest is
 *  the encrypted full value. Cheap, deterministic, no extra column. */
function packKeyWithPrefix(plain: string, id: number): { stored: string; prefix: string } {
  const prefix = plain.slice(0, 4);
  return { stored: prefix + '|' + encryptSecret(plain, aadFor(id)), prefix };
}

function unpackPrefix(stored: string): string {
  const sep = stored.indexOf('|');
  if (sep === -1) return '';
  return stored.slice(0, sep);
}

function unpackKey(stored: string, id: number): string {
  const sep = stored.indexOf('|');
  if (sep === -1) return decryptSecret(stored, aadFor(id));   // legacy: no prefix wrapper
  return decryptSecret(stored.slice(sep + 1), aadFor(id));
}

function rowToPublic(r: DbRow): ApiKeyRow {
  return {
    id: r.id,
    name: r.name,
    provider: r.provider as ApiKeyProvider,
    prefix: unpackPrefix(r.key_enc),
    created_at: r.created_at,
    last_used_at: r.last_used_at,
    use_count: r.use_count,
    revoked_at: r.revoked_at,
  };
}

export class ApiKeyStore {
  constructor(private readonly db: Db) {}

  /**
   * Mint = encrypt + insert. Returns plaintext exactly once.
   *
   * The encryption AAD binds the ciphertext to the row's id, but we
   * don't know the id until AFTER the INSERT. Two-step in a single
   * transaction: INSERT with an empty key_enc placeholder, read back the
   * auto-increment id, encrypt with id-bound AAD, UPDATE the row. The
   * transaction makes the placeholder window invisible to readers.
   */
  mint(name: string, provider: ApiKeyProvider, plaintext: string): MintedApiKey {
    if (!name.trim()) throw new Error('api-key name required');
    if (!plaintext.trim()) throw new Error('api-key plaintext required');
    if (!API_KEY_PROVIDERS.includes(provider)) {
      throw new Error(`unknown provider: ${provider}`);
    }
    const trimmedName = name.trim();
    const trimmedPlain = plaintext.trim();

    const tx = this.db.transaction(() => {
      const r = this.db
        .prepare(`INSERT INTO api_keys (name, provider, key_enc) VALUES (?, ?, ?)`)
        .run(trimmedName, provider, '');
      const id = Number(r.lastInsertRowid);
      const { stored, prefix } = packKeyWithPrefix(trimmedPlain, id);
      this.db.prepare(`UPDATE api_keys SET key_enc = ? WHERE id = ?`).run(stored, id);
      const row = this.db.prepare('SELECT created_at FROM api_keys WHERE id = ?').get(id) as { created_at: number };
      return { id, prefix, created_at: row.created_at };
    });
    const { id, prefix, created_at } = tx();
    logger.info('api-key.mint', { id, name: trimmedName, provider });
    return { id, name: trimmedName, provider, plaintext: trimmedPlain, prefix, created_at };
  }

  /** Public listing. Never includes decrypted plaintext.
   *  Ordered by id DESC (monotonic) — created_at has 1-second resolution
   *  and rapid mints from the same request would otherwise tie. */
  list(): ApiKeyRow[] {
    const rows = this.db
      .prepare('SELECT * FROM api_keys ORDER BY id DESC')
      .all() as DbRow[];
    return rows.map(rowToPublic);
  }

  /** Public read by id. Never includes decrypted plaintext. */
  read(id: number): ApiKeyRow | null {
    const row = this.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as DbRow | undefined;
    return row ? rowToPublic(row) : null;
  }

  /**
   * Return the decrypted plaintext for in-process use only. Callers MUST
   * NOT pass this to anything that logs or persists. Each successful use
   * bumps last_used_at + use_count for audit purposes. Returns null if the
   * row is missing or revoked.
   */
  reveal(id: number): { plaintext: string; provider: ApiKeyProvider; name: string } | null {
    const row = this.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as DbRow | undefined;
    // Equivalent to `if (!row || row.revoked_at !== null) return null`:
    // when row is undefined, row?.revoked_at is undefined, undefined !== null is true.
    if (row?.revoked_at !== null) return null;
    const plaintext = unpackKey(row.key_enc, row.id);
    this.db
      .prepare(`UPDATE api_keys SET last_used_at = strftime('%s','now'), use_count = use_count + 1 WHERE id = ?`)
      .run(id);
    return { plaintext, provider: row.provider as ApiKeyProvider, name: row.name };
  }

  revoke(id: number): boolean {
    const r = this.db
      .prepare(`UPDATE api_keys SET revoked_at = strftime('%s','now') WHERE id = ? AND revoked_at IS NULL`)
      .run(id);
    if (r.changes > 0) logger.info('api-key.revoke', { id });
    return r.changes > 0;
  }

  /** Same hygiene as TokenStore: must revoke before delete to make
   *  accidental rm-rf less likely. */
  delete(id: number): boolean {
    const r = this.db
      .prepare(`DELETE FROM api_keys WHERE id = ? AND revoked_at IS NOT NULL`)
      .run(id);
    if (r.changes > 0) logger.info('api-key.delete', { id });
    return r.changes > 0;
  }
}
