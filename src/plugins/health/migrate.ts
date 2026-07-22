import type { PluginDb } from '../types.js';

export function migrate(db: PluginDb): void {
  const obs = db.table('observations');
  const meds = db.table('medications');
  const plans = db.table('insurance_plans');
  const benefits = db.table('insurance_benefits');
  const documents = db.table('documents');
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${obs} (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      date       TEXT NOT NULL,
      kind       TEXT NOT NULL DEFAULT 'other',
      label      TEXT NOT NULL,
      value      REAL NOT NULL,
      unit       TEXT NOT NULL DEFAULT '',
      ref_low    REAL,
      ref_high   REAL,
      flag       TEXT NOT NULL DEFAULT '',
      source     TEXT NOT NULL DEFAULT 'manual',
      note       TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_${obs}_label ON ${obs}(label, date);
    CREATE TABLE IF NOT EXISTS ${meds} (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      dose       TEXT NOT NULL DEFAULT '',
      frequency  TEXT NOT NULL DEFAULT '',
      route      TEXT NOT NULL DEFAULT '',
      start_date TEXT NOT NULL DEFAULT '',
      end_date   TEXT,
      active     INTEGER NOT NULL DEFAULT 1,
      prescriber TEXT NOT NULL DEFAULT '',
      rx_number  TEXT NOT NULL DEFAULT '',
      pharmacy   TEXT NOT NULL DEFAULT '',
      note       TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS ${plans} (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_year             INTEGER NOT NULL DEFAULT 0,
      carrier               TEXT NOT NULL DEFAULT '',
      plan_name             TEXT NOT NULL DEFAULT '',
      plan_type             TEXT NOT NULL DEFAULT '',
      member_id             TEXT NOT NULL DEFAULT '',
      group_number          TEXT NOT NULL DEFAULT '',
      effective_from        TEXT NOT NULL DEFAULT '',
      effective_to          TEXT NOT NULL DEFAULT '',
      premium_monthly       REAL,
      deductible_individual REAL,
      deductible_family     REAL,
      deductible_met        REAL NOT NULL DEFAULT 0,
      oop_max_individual    REAL,
      oop_max_family        REAL,
      oop_met               REAL NOT NULL DEFAULT 0,
      active                INTEGER NOT NULL DEFAULT 1,
      note                  TEXT NOT NULL DEFAULT '',
      created_at            INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at            INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS ${benefits} (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id          INTEGER NOT NULL,
      category         TEXT NOT NULL,
      network          TEXT NOT NULL DEFAULT 'in',
      cost_type        TEXT NOT NULL DEFAULT 'copay',
      amount           REAL NOT NULL DEFAULT 0,
      after_deductible INTEGER NOT NULL DEFAULT 0,
      note             TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_${benefits}_plan ON ${benefits}(plan_id);
    CREATE TABLE IF NOT EXISTS ${documents} (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      category   TEXT NOT NULL DEFAULT 'note',
      title      TEXT NOT NULL DEFAULT '',
      source     TEXT NOT NULL DEFAULT 'paste',
      text       TEXT NOT NULL DEFAULT '',
      ref_type   TEXT NOT NULL DEFAULT '',
      ref_id     INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_${documents}_cat ON ${documents}(category);
  `);
}
