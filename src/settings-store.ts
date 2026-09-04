/**
 * Operator-editable runtime settings. Plain key/value, no encryption — this is
 * for knobs an operator tunes (retention counts, rate limits, endpoints), NOT
 * for credentials. Secrets belong in the SecretStore, which is encrypted and
 * whose values the admin API never returns.
 *
 * Deliberately not a mirror of the environment: a setting lives here or it
 * lives in the env file, never both. Values that can turn a protection OFF
 * (auth mode, sandbox switches, allowed hosts) stay in the root-owned env file
 * on purpose — the admin UI is reachable with an admin token, and a leaked
 * token must not be able to disable a defence. Knobs that only tighten or
 * loosen a bound, like the OAuth rate limits, do live here: the floor is the
 * code default, so the worst an editor can do is inconvenience themselves.
 */
import type { Db } from './db.js';
import { logger } from './util/log.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
`;

export class SettingsStore {
  constructor(private readonly db: Db) {
    this.db.exec(SCHEMA);
  }

  get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  /** Numeric read with a caller-supplied default. A stored value that isn't a
   *  finite number falls back rather than propagating NaN into a timer or a
   *  rate limit, where it would silently disable the thing it configures. */
  getNumber(key: string, fallback: number): number {
    const raw = this.get(key)?.trim();
    // Empty is unset, not zero: Number('') is 0, and a 0 TTL or rate limit
    // disables the thing it configures instead of defaulting it.
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      logger.warn('settings.bad-number', { key, using: fallback });
      return fallback;
    }
    return n;
  }

  set(key: string, value: string): void {
    this.db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')`,
    ).run(key, value);
    logger.info('settings.set', { key });
  }

  delete(key: string): boolean {
    return this.db.prepare('DELETE FROM settings WHERE key = ?').run(key).changes > 0;
  }

  all(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM settings ORDER BY key').all() as
      Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  }
}
