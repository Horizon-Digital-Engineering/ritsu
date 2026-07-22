import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { ScopedDb, assertScopedSql } from '../plugins/host.js';

// SEC-6: the model-reachable plugin DB handle (tool + route handlers) may only
// touch its own plugin_<id>_* tables. assertScopedSql is the guard; the guarded
// ScopedDb applies it on prepare/exec. The install-time migrate() handle stays
// unguarded (trusted, imports legacy data), so cross-table reads still work
// there.
describe('assertScopedSql (SEC-6 plugin table guard)', () => {
  const ok = (sql: string) => assert.doesNotThrow(() => assertScopedSql(sql, 'myid'));
  const bad = (sql: string, re: RegExp) => assert.throws(() => assertScopedSql(sql, 'myid'), re);

  it('allows queries against the plugin\'s own tables', () => {
    ok('SELECT * FROM plugin_myid_things ORDER BY name COLLATE NOCASE ASC');
    ok('DELETE FROM plugin_myid_things WHERE id = ?');
    ok('SELECT a.* FROM plugin_myid_a a JOIN plugin_myid_b b ON a.id = b.a_id');
  });

  it('allows an upsert (DO UPDATE SET is not a table reference)', () => {
    ok('INSERT INTO plugin_myid_things (id, n) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET n = excluded.n');
  });

  it('rejects a core table', () => {
    bad('SELECT * FROM agent_definitions', /own tables/);
    bad('SELECT token_hash FROM mcp_tokens', /own tables/);
    bad('UPDATE plugin_registry SET enabled = 1', /own tables/);
  });

  it('rejects another plugin\'s tables', () => {
    bad('SELECT * FROM plugin_other_secrets', /own tables/);
  });

  it('rejects SQL comments, sqlite_* schema tables, and schema/attach verbs', () => {
    bad('SELECT 1 FROM plugin_myid_things -- sneaky', /comments/);
    bad('SELECT 1 FROM plugin_myid_things /* x */', /comments/);
    bad('SELECT name FROM sqlite_master', /sqlite_/);
    bad('PRAGMA table_info(plugin_myid_things)', /PRAGMA/);
    bad('ATTACH DATABASE \'/etc/passwd\' AS x', /ATTACH/);
  });

  it('is not fooled by a table name hidden in a string literal', () => {
    // The literal 'agent_definitions' is data, not a table ref — allowed.
    ok("INSERT INTO plugin_myid_things (note) VALUES ('select from agent_definitions')");
  });
});

describe('ScopedDb guarded vs unguarded', () => {
  it('guarded handle blocks cross-table access; unguarded (migrate) allows it', () => {
    const db = openDatabase(':memory:');
    db.exec('CREATE TABLE plugin_myid_things (id INTEGER PRIMARY KEY, n INTEGER)');

    const guarded = new ScopedDb(db, 'myid', true);
    // own table — fine
    assert.doesNotThrow(() => guarded.prepare('SELECT * FROM plugin_myid_things'));
    // core table — blocked before it ever reaches sqlite
    assert.throws(() => guarded.prepare('SELECT * FROM agent_definitions'), /own tables/);
    assert.throws(() => guarded.exec('DROP TABLE agent_definitions'), /own tables/);

    // The migrate handle is unguarded: legacy cross-table import must still work.
    const migrateHandle = new ScopedDb(db, 'myid');
    assert.doesNotThrow(() => migrateHandle.prepare('SELECT id FROM agent_definitions'));
  });
});
