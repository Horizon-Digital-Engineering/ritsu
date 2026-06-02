/**
 * Plugin secret store — encrypted credentials for connectors (CRM email,
 * social APIs, etc.). Same crypto posture as ApiKeyStore: AES-256-GCM at
 * rest (via secret-crypto), plaintext only ever materialised in-process when
 * a tool/plugin handler needs it.
 *
 * The defining property for the CRM: there is NO agent-callable accessor.
 * `get()` is called only from connector handlers (running in our process);
 * an agent asks "send from the work account" with an opaque reference, and
 * the handler resolves the actual SMTP password internally. The LLM never
 * sees a credential.
 *
 * Keyed by (namespace, name): namespace groups a connector's secrets
 * (e.g. 'email'), name is the field ('smtp_password', 'imap_user', …).
 */
import type { Db } from '../db.js';
import { encryptSecret, decryptSecret } from '../util/secret-crypto.js';
import { logger } from '../util/log.js';

/** Metadata returned to the admin UI — NEVER the value. */
export interface SecretMeta {
  namespace: string;
  name: string;
  created_at: number;
  updated_at: number;
}

interface DbRow {
  namespace: string;
  name: string;
  value_enc: string;
  created_at: number;
  updated_at: number;
}

/** AAD binds the ciphertext to its (namespace, name) — both stable for the
 *  row's life — so a value can't be lifted into a different secret slot and
 *  decrypted there. Same string must be used at encrypt + decrypt. */
function aadFor(namespace: string, name: string): string {
  return `secret:ns=${namespace}:name=${name}`;
}

export class SecretStore {
  constructor(private readonly db: Db) {}

  /** Upsert a secret (encrypt + store). Operator-only path — wired to the
   *  admin API, never to an agent tool. */
  set(namespace: string, name: string, plaintext: string): void {
    const ns = namespace.trim();
    const nm = name.trim();
    if (!ns || !nm) throw new Error('secret namespace and name required');
    if (!plaintext) throw new Error('secret value required');
    const enc = encryptSecret(plaintext, aadFor(ns, nm));
    this.db.prepare(
      `INSERT INTO plugin_secrets (namespace, name, value_enc) VALUES (?, ?, ?)
       ON CONFLICT(namespace, name) DO UPDATE SET
         value_enc = excluded.value_enc,
         updated_at = strftime('%s','now')`,
    ).run(ns, nm, enc);
    logger.info('secret.set', { namespace: ns, name: nm });
  }

  /**
   * Decrypt a secret for in-process handler use ONLY. Returns null if absent.
   * Callers MUST NOT log it, persist it, or return it to a model. This is the
   * single decrypt path and it is never exposed as an agent tool.
   */
  get(namespace: string, name: string): string | null {
    const row = this.db
      .prepare('SELECT value_enc FROM plugin_secrets WHERE namespace = ? AND name = ?')
      .get(namespace, name) as { value_enc: string } | undefined;
    if (!row) return null;
    return decryptSecret(row.value_enc, aadFor(namespace, name));
  }

  /** Presence check without decrypting — safe to expose more freely. */
  has(namespace: string, name: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM plugin_secrets WHERE namespace = ? AND name = ?')
      .get(namespace, name);
  }

  /** Metadata listing — namespace/name/timestamps, NEVER values. For the
   *  admin UI so the operator can see what's configured. */
  list(namespace?: string): SecretMeta[] {
    const rows = namespace
      ? this.db.prepare(
          `SELECT namespace, name, created_at, updated_at FROM plugin_secrets
           WHERE namespace = ? ORDER BY namespace, name`,
        ).all(namespace.trim())
      : this.db.prepare(
          `SELECT namespace, name, created_at, updated_at FROM plugin_secrets
           ORDER BY namespace, name`,
        ).all();
    return (rows as DbRow[]).map(r => ({
      namespace: r.namespace,
      name: r.name,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  }

  delete(namespace: string, name: string): boolean {
    const r = this.db
      .prepare('DELETE FROM plugin_secrets WHERE namespace = ? AND name = ?')
      .run(namespace, name);
    if (r.changes > 0) logger.info('secret.delete', { namespace, name });
    return r.changes > 0;
  }
}
