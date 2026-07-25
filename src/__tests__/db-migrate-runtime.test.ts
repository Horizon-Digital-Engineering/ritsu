import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db.js';

/** The pre-runtime agent_definitions shape (dispatcher column + nullable
 *  provider), as it existed on deployed DBs. */
const LEGACY_DDL = `
CREATE TABLE agent_definitions (
  id                     TEXT PRIMARY KEY,
  type                   TEXT NOT NULL,
  name                   TEXT NOT NULL,
  description            TEXT NOT NULL,
  system_prompt          TEXT NOT NULL,
  dispatcher             TEXT NOT NULL CHECK (dispatcher IN ('claude-direct','litellm')),
  model                  TEXT NOT NULL,
  memory_backend         TEXT NOT NULL DEFAULT 'sqlite',
  tools_allowlist        TEXT NOT NULL DEFAULT '[]',
  enabled                INTEGER NOT NULL DEFAULT 1,
  created_at             INTEGER NOT NULL DEFAULT 111,
  updated_at             INTEGER NOT NULL DEFAULT 222,
  previous_system_prompt TEXT,
  previous_saved_at      INTEGER,
  can_call               TEXT NOT NULL DEFAULT '[]',
  provider               TEXT,
  api_key_ref            INTEGER,
  provider_options       TEXT NOT NULL DEFAULT '{}',
  capabilities           TEXT NOT NULL DEFAULT '[]',
  approval_tools         TEXT NOT NULL DEFAULT '[]',
  plugins                TEXT NOT NULL DEFAULT '[]',
  escalation_approvable  INTEGER NOT NULL DEFAULT 0,
  allow_monitor_read     INTEGER NOT NULL DEFAULT 0
);`;

describe('agent runtime migration (dispatcher → runtime/provider)', () => {
  it('rebuilds legacy rows into the two-tier shape', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'ritsu-migrate-')), 'legacy.db');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(LEGACY_DDL);
    legacy.exec(`
      INSERT INTO agent_definitions (id, type, name, description, system_prompt, dispatcher, model)
        VALUES ('plain', 'generic', 'Plain', 'claude-sdk agent', 'be plain', 'claude-direct', 'claude-sonnet-4-6');
      INSERT INTO agent_definitions (id, type, name, description, system_prompt, dispatcher, model, provider, api_key_ref)
        VALUES ('keyed', 'generic', 'Keyed', 'openai agent', 'be keyed', 'claude-direct', 'gpt-test', 'openai', 7);`);
    legacy.close();

    const db = openDatabase(dbPath);
    const rows = db.prepare('SELECT id, runtime, provider, api_key_ref FROM agent_definitions ORDER BY id').all() as
      Array<{ id: string; runtime: string; provider: string; api_key_ref: number | null }>;

    const plain = rows.find(r => r.id === 'plain')!;
    assert.deepEqual({ runtime: plain.runtime, provider: plain.provider }, { runtime: 'direct', provider: 'claude' });

    const keyed = rows.find(r => r.id === 'keyed')!;
    assert.deepEqual(
      { runtime: keyed.runtime, provider: keyed.provider, ref: keyed.api_key_ref },
      { runtime: 'api', provider: 'openai', ref: 7 },
    );

    const cols = db.prepare('PRAGMA table_info(agent_definitions)').all() as Array<{ name: string }>;
    assert.ok(!cols.some(c => c.name === 'dispatcher'), 'dispatcher column is gone');

    // Idempotent: reopening a migrated DB must not rebuild again.
    db.close();
    const again = openDatabase(dbPath);
    assert.equal((again.prepare('SELECT COUNT(*) AS n FROM agent_definitions').get() as { n: number }).n, rows.length);
    again.close();
  });

  it('maps openai-compat rows to openrouter', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'ritsu-migrate-')), 'compat.db');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(LEGACY_DDL);
    legacy.exec(`
      INSERT INTO agent_definitions (id, type, name, description, system_prompt, dispatcher, model, provider, api_key_ref)
        VALUES ('router', 'generic', 'Router', 'openrouter agent', 'route', 'claude-direct', 'meta/some-model', 'openai-compat', 9);`);
    legacy.close();

    const db = openDatabase(dbPath);
    const row = db.prepare("SELECT runtime, provider FROM agent_definitions WHERE id = 'router'").get() as
      { runtime: string; provider: string };
    assert.deepEqual(row, { runtime: 'api', provider: 'openrouter' });
    db.close();
  });
});
