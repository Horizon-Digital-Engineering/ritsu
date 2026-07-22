import type { PluginDb } from '../types.js';

/** Scoped tables for the finance cache. Access tokens are NOT stored here —
 *  they live in the SecretStore (plugin:finance namespace). */
export function migrate(db: PluginDb): void {
  const items = db.table('items');
  const accounts = db.table('accounts');
  const txns = db.table('transactions');
  const targets = db.table('category_targets');
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${items} (
      item_id          TEXT PRIMARY KEY,
      institution_id   TEXT NOT NULL DEFAULT '',
      institution_name TEXT NOT NULL DEFAULT '',
      cursor           TEXT,
      status           TEXT NOT NULL DEFAULT 'active',
      error            TEXT,
      created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS ${accounts} (
      account_id        TEXT PRIMARY KEY,
      item_id           TEXT NOT NULL,
      name              TEXT NOT NULL DEFAULT '',
      official_name     TEXT NOT NULL DEFAULT '',
      type              TEXT NOT NULL DEFAULT '',
      subtype           TEXT NOT NULL DEFAULT '',
      mask              TEXT NOT NULL DEFAULT '',
      current_balance   REAL,
      available_balance REAL,
      iso_currency      TEXT NOT NULL DEFAULT 'USD',
      updated_at        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_${accounts}_item ON ${accounts}(item_id);
    CREATE TABLE IF NOT EXISTS ${txns} (
      transaction_id    TEXT PRIMARY KEY,
      account_id        TEXT NOT NULL,
      date              TEXT NOT NULL,
      name              TEXT NOT NULL DEFAULT '',
      merchant_name     TEXT NOT NULL DEFAULT '',
      amount            REAL NOT NULL DEFAULT 0,
      iso_currency      TEXT NOT NULL DEFAULT 'USD',
      category          TEXT NOT NULL DEFAULT '',
      category_detailed TEXT NOT NULL DEFAULT '',
      pending           INTEGER NOT NULL DEFAULT 0,
      updated_at        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_${txns}_date ON ${txns}(date);
    CREATE INDEX IF NOT EXISTS idx_${txns}_account ON ${txns}(account_id);
    CREATE TABLE IF NOT EXISTS ${targets} (
      category      TEXT PRIMARY KEY,
      monthly_limit REAL NOT NULL,
      updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);
}
