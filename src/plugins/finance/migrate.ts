import type { PluginDb } from '../types.js';
import { seedCategories } from './categories.js';

const SCHEMA = '3';

/**
 * The ledger. Amounts are signed from the account holder's side: inflow
 * positive, outflow negative, and a liability account's balance is negative,
 * so net worth is a plain sum. Provider credentials are never here — they live
 * in the SecretStore under the plugin's namespace.
 */
export function migrate(db: PluginDb): void {
  const t = (n: string) => db.table(n);
  // 0.1.0 was a Plaid cache that never held data; its tables share names with
  // the ledger but not columns, so a first boot on the new schema drops them.
  const hasMeta = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t('meta'));
  if (!hasMeta) {
    for (const legacy of ['items', 'accounts', 'transactions', 'category_targets']) {
      db.exec(`DROP TABLE IF EXISTS ${t(legacy)}`);
    }
  }
  db.exec(`
    -- File import was removed; its table and index go with it.
    DROP TABLE IF EXISTS ${t('imports')};
    DROP INDEX IF EXISTS idx_${t('transactions')}_fp;
    CREATE TABLE IF NOT EXISTS ${t('meta')} (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR REPLACE INTO ${t('meta')} (key, value) VALUES ('schema', '${SCHEMA}');

    CREATE TABLE IF NOT EXISTS ${t('connections')} (
      id             TEXT PRIMARY KEY,
      provider       TEXT NOT NULL,
      label          TEXT NOT NULL DEFAULT '',
      status         TEXT NOT NULL DEFAULT 'active',
      error          TEXT,
      cursor         TEXT,
      last_synced_at INTEGER,
      created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS ${t('accounts')} (
      id                  TEXT PRIMARY KEY,
      connection_id       TEXT,
      provider_account_id TEXT NOT NULL DEFAULT '',
      name                TEXT NOT NULL DEFAULT '',
      official_name       TEXT NOT NULL DEFAULT '',
      type                TEXT NOT NULL DEFAULT 'depository',
      subtype             TEXT NOT NULL DEFAULT '',
      mask                TEXT NOT NULL DEFAULT '',
      institution         TEXT NOT NULL DEFAULT '',
      balance             REAL NOT NULL DEFAULT 0,
      available_balance   REAL,
      currency            TEXT NOT NULL DEFAULT 'USD',
      balance_as_of       TEXT NOT NULL DEFAULT '',
      hidden              INTEGER NOT NULL DEFAULT 0,
      closed              INTEGER NOT NULL DEFAULT 0,
      sort_order          INTEGER NOT NULL DEFAULT 0,
      zip                 TEXT NOT NULL DEFAULT '',
      anchor_value        REAL,
      anchor_date         TEXT NOT NULL DEFAULT '',
      created_at          INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at          INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_${t('accounts')}_conn ON ${t('accounts')}(connection_id);

    CREATE TABLE IF NOT EXISTS ${t('balance_history')} (
      account_id TEXT NOT NULL,
      date       TEXT NOT NULL,
      balance    REAL NOT NULL,
      PRIMARY KEY (account_id, date)
    );

    CREATE TABLE IF NOT EXISTS ${t('categories')} (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      group_name TEXT NOT NULL DEFAULT '',
      kind       TEXT NOT NULL DEFAULT 'expense',
      sort       INTEGER NOT NULL DEFAULT 0,
      archived   INTEGER NOT NULL DEFAULT 0,
      builtin    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ${t('provider_category_map')} (
      provider_category TEXT PRIMARY KEY,
      category_id       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ${t('transactions')} (
      id                TEXT PRIMARY KEY,
      account_id        TEXT NOT NULL,
      date              TEXT NOT NULL,
      description       TEXT NOT NULL DEFAULT '',
      payee             TEXT NOT NULL DEFAULT '',
      amount            REAL NOT NULL,
      currency          TEXT NOT NULL DEFAULT 'USD',
      category_id       TEXT,
      category_source   TEXT NOT NULL DEFAULT 'none',
      provider_category TEXT NOT NULL DEFAULT '',
      pending           INTEGER NOT NULL DEFAULT 0,
      notes             TEXT NOT NULL DEFAULT '',
      reviewed          INTEGER NOT NULL DEFAULT 0,
      excluded          INTEGER NOT NULL DEFAULT 0,
      transfer_group    TEXT,
      source            TEXT NOT NULL DEFAULT 'sync',
      created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_${t('transactions')}_date ON ${t('transactions')}(date);
    CREATE INDEX IF NOT EXISTS idx_${t('transactions')}_account ON ${t('transactions')}(account_id, date);
    CREATE INDEX IF NOT EXISTS idx_${t('transactions')}_category ON ${t('transactions')}(category_id);

    CREATE TABLE IF NOT EXISTS ${t('splits')} (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id TEXT NOT NULL,
      category_id    TEXT,
      amount         REAL NOT NULL,
      notes          TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_${t('splits')}_txn ON ${t('splits')}(transaction_id);

    CREATE TABLE IF NOT EXISTS ${t('transaction_tags')} (
      transaction_id TEXT NOT NULL,
      tag            TEXT NOT NULL,
      PRIMARY KEY (transaction_id, tag)
    );

    CREATE TABLE IF NOT EXISTS ${t('rules')} (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      priority        INTEGER NOT NULL DEFAULT 100,
      enabled         INTEGER NOT NULL DEFAULT 1,
      field           TEXT NOT NULL DEFAULT 'any',
      op              TEXT NOT NULL DEFAULT 'contains',
      pattern         TEXT NOT NULL,
      amount_min      REAL,
      amount_max      REAL,
      account_id      TEXT,
      set_category_id TEXT,
      set_payee       TEXT,
      set_excluded    INTEGER,
      set_tags        TEXT NOT NULL DEFAULT '[]',
      created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS ${t('budgets')} (
      category_id TEXT NOT NULL,
      month       TEXT NOT NULL DEFAULT '*',
      amount      REAL NOT NULL,
      PRIMARY KEY (category_id, month)
    );

    CREATE TABLE IF NOT EXISTS ${t('recurring')} (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      payee_key    TEXT NOT NULL,
      display_name TEXT NOT NULL,
      category_id  TEXT,
      account_id   TEXT,
      amount       REAL NOT NULL,
      cadence      TEXT NOT NULL,
      last_date    TEXT NOT NULL DEFAULT '',
      next_date    TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'detected',
      occurrences  INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      UNIQUE (payee_key, account_id)
    );

    CREATE TABLE IF NOT EXISTS ${t('goals')} (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      kind          TEXT NOT NULL DEFAULT 'save',
      target_amount REAL NOT NULL,
      target_date   TEXT,
      account_ids   TEXT NOT NULL DEFAULT '[]',
      start_balance REAL,
      created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS ${t('holdings')} (
      id           TEXT PRIMARY KEY,
      account_id   TEXT NOT NULL,
      symbol       TEXT NOT NULL DEFAULT '',
      description  TEXT NOT NULL DEFAULT '',
      quantity     REAL,
      price        REAL,
      market_value REAL,
      cost_basis   REAL,
      currency     TEXT NOT NULL DEFAULT 'USD',
      as_of        TEXT NOT NULL DEFAULT '',
      updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);
  // A property's valuation anchor arrived after accounts first shipped.
  const cols = (db.prepare(`PRAGMA table_info(${t('accounts')})`).all() as Array<{ name: string }>).map(c => c.name);
  if (!cols.includes('zip')) db.exec(`ALTER TABLE ${t('accounts')} ADD COLUMN zip TEXT NOT NULL DEFAULT ''`);
  if (!cols.includes('anchor_value')) db.exec(`ALTER TABLE ${t('accounts')} ADD COLUMN anchor_value REAL`);
  if (!cols.includes('anchor_date')) db.exec(`ALTER TABLE ${t('accounts')} ADD COLUMN anchor_date TEXT NOT NULL DEFAULT ''`);
  seedCategories(db);
}
