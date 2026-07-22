import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db.js';
import { BackupManager } from '../backup.js';

describe('BackupManager', () => {
  let tmp: string;
  let mgr: BackupManager;
  let dbFile: string;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ritsu-bk-'));
    dbFile = join(tmp, 'ritsu.db');
    const db = openDatabase(dbFile);
    db.prepare("INSERT INTO memories (agent_id, content, lineage_root_id) VALUES ('hello-world', 'user prefers metric', 0)").run();
    db.prepare("INSERT INTO mcp_tokens (name, token_hash, token_prefix, scope) VALUES ('t', 'deadbeef', 'rt_', 'mcp')").run();
    mgr = new BackupManager(db, dbFile, join(tmp, 'backups'));
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('creates a full, restorable snapshot; disambiguates rapid backups', () => {
    const a = mgr.createBackup();
    const b = mgr.createBackup();
    const c = mgr.createBackup();
    assert.ok(a.size > 0);
    assert.notEqual(a.name, b.name);
    assert.notEqual(b.name, c.name);
    assert.equal(mgr.listBackups().length, 3);

    // the snapshot really contains the data
    const restored = openDatabase(mgr.pathFor(a.name)!);
    assert.equal((restored.prepare('SELECT count(*) c FROM memories').get() as { c: number }).c, 1);
  });

  it('export includes your data but excludes secrets/tokens', () => {
    const exp = mgr.exportJson();
    assert.equal((exp.tables.memories as unknown[]).length, 1);
    assert.equal(exp.tables.agent_definitions !== undefined, true);
    assert.equal(exp.tables.mcp_tokens, undefined);       // excluded
    assert.equal(exp.tables.plugin_secrets, undefined);   // excluded
    assert.equal(exp.tables.oauth_clients, undefined);    // excluded
  });

  it('prune keeps the newest N', () => {
    // 3 exist from the first test; keep 2
    assert.equal(mgr.prune(2), 1);
    assert.equal(mgr.listBackups().length, 2);
  });

  it('pathFor rejects traversal + unknown names', () => {
    assert.equal(mgr.pathFor('../../etc/passwd'), null);
    assert.equal(mgr.pathFor('nope.db'), null);
    assert.equal(mgr.pathFor('ritsu-x.txt'), null);
  });
});
