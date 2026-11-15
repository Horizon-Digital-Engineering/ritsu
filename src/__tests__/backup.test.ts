import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../db.js';
import {
  BackupManager, _setScryptWorkFactorForTests, checkNotStranded, createBackupFrom, decryptFile, fileName,
  integrityError, latestBackup, loadPassword, parseName, preUpgrade, rehearse, restore, savePassword, WrongPassword,
  RehearsalError, migrateCopy,
} from '../backup.js';

// scrypt at the pinned work factor is seconds per file; the tests only need the format.
_setScryptWorkFactorForTests(10);
const PW = 'correct horse battery staple';

describe('backup names', () => {
  it('round-trip through fileName/parseName, pre-upgrade mark included', () => {
    const at = new Date('2026-11-13T17:11:02Z');
    const daily = fileName('homelab-2', 'daily', at);
    assert.equal(daily, 'ritsu-homelab-2-20261113T171102Z.db.age');
    assert.deepEqual(parseName(daily), { host: 'homelab-2', kind: 'daily', at });
    const pre = fileName('homelab-2', 'pre-upgrade', at);
    assert.equal(pre, 'ritsu-homelab-2-pre-upgrade-20261113T171102Z.db.age');
    assert.deepEqual(parseName(pre), { host: 'homelab-2', kind: 'pre-upgrade', at });
  });

  it('rejects anything that is not a backup name', () => {
    assert.equal(parseName('ritsu-2026-11-13T17-11-02-000Z.db'), null, 'the old plaintext snapshots');
    assert.equal(parseName('ritsu-host-20261113T171102Z.db.age.partial'), null);
    assert.equal(parseName('ritsu-../x-20261113T171102Z.db.age'), null);
    assert.equal(parseName('ritsu--20261113T171102Z.db.age'), null);
  });

  it('latest is the newest daily, falling back to a pre-upgrade copy', () => {
    const list = [
      { name: 'c', host: 'a', kind: 'pre-upgrade' as const, created_at: 300, size: 1 },
      { name: 'b', host: 'b', kind: 'daily' as const, created_at: 200, size: 1 },
      { name: 'a', host: 'a', kind: 'daily' as const, created_at: 100, size: 1 },
      { name: 'z', host: 'z', kind: 'pre-upgrade' as const, created_at: 50, size: 1 },
    ];
    assert.equal(latestBackup(list)?.name, 'b');
    assert.equal(latestBackup(list, 'a')?.name, 'a');
    assert.equal(latestBackup(list, 'z')?.name, 'z');
    assert.equal(latestBackup(list, 'nope'), undefined);
  });
});

describe('BackupManager', () => {
  let tmp: string;
  let mgr: BackupManager;
  let dbFile: string;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ritsu-bk-'));
    dbFile = join(tmp, 'data', 'ritsu.db');
    const db = openDatabase(dbFile);
    db.prepare("INSERT INTO memories (agent_id, content, lineage_root_id) VALUES ('hello-world', 'user prefers metric', 0)").run();
    db.prepare("INSERT INTO mcp_tokens (name, token_hash, token_prefix, scope) VALUES ('t', 'deadbeef', 'rt_', 'mcp')").run();
    mgr = new BackupManager(db, dbFile, join(tmp, 'backups'), { host: 'testbox' });
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('refuses to back up without a password, and a short password is refused', async () => {
    assert.equal(mgr.passwordSet(), false);
    await assert.rejects(mgr.createBackup(), /no backup password set/);
    assert.throws(() => mgr.setPassword('short'), /at least 15 characters/);
    mgr.setPassword(PW);
    assert.equal(mgr.passwordSet(), true);
    assert.equal(loadPassword(join(tmp, 'data')), PW);
  });

  it('creates encrypted snapshots that decrypt back to the data; same-second names stay distinct', async () => {
    const a = await mgr.createBackup();
    const b = await mgr.createBackup();
    assert.ok(a.size > 0);
    assert.notEqual(a.name, b.name);
    assert.equal(a.host, 'testbox');
    assert.equal(a.kind, 'daily');
    assert.deepEqual(mgr.listBackups().map(x => x.name), [b.name, a.name], 'newest first');
    // No plaintext left beside the database.
    assert.deepEqual(readdirSync(join(tmp, 'data')).filter(n => n.startsWith('.backup-')), []);

    const plain = join(tmp, 'plain.db');
    await decryptFile(mgr.pathFor(a.name)!, plain, PW);
    assert.equal(integrityError(plain), null);
    const restored = new DatabaseSync(plain, { readOnly: true });
    assert.equal((restored.prepare('SELECT count(*) c FROM memories').get() as { c: number }).c, 1);
    assert.equal((restored.prepare('SELECT count(*) c FROM mcp_tokens').get() as { c: number }).c, 1, 'a backup is complete');
    restored.close();
  });

  it('the wrong password is told apart from a damaged file', async () => {
    const name = mgr.listBackups()[0].name;
    await assert.rejects(decryptFile(mgr.pathFor(name)!, join(tmp, 'x.db'), 'not the password at all'), WrongPassword);
    const junk = join(tmp, 'junk.db.age');
    writeFileSync(junk, 'age-encryption.org/v1\n-> scrypt\n');
    await assert.rejects(decryptFile(junk, join(tmp, 'y.db'), PW), /not a backup file/);
  });

  it('due() follows this host\'s newest daily backup', () => {
    assert.equal(mgr.due(24), false, 'just backed up');
    const stale = join(tmp, 'stale');
    mkdirSync(stale);
    writeFileSync(join(stale, fileName('testbox', 'daily', new Date(Date.now() - 48 * 3_600_000))), '');
    const old = new BackupManager(null, dbFile, stale, { host: 'testbox' });
    assert.equal(old.due(24), true, 'two days old');
    assert.equal(old.due(72), false);
    assert.equal(new BackupManager(null, dbFile, join(tmp, 'empty'), { host: 'testbox' }).due(24), true, 'none yet');
  });

  it('prune keeps the newest N daily and the pre-upgrade copies apart', async () => {
    await mgr.createBackup('pre-upgrade');
    assert.equal(mgr.listBackups().length, 3);
    assert.equal(mgr.prune(1), 1);
    const left = mgr.listBackups();
    assert.deepEqual(left.map(b => b.kind).sort((x, y) => x.localeCompare(y)), ['daily', 'pre-upgrade']);
    assert.equal(mgr.prune(0), 0, 'keep is floored at 1');
  });

  it('prune leaves other hosts\' backups alone', async () => {
    const other = new BackupManager(mgr['db'], dbFile, join(tmp, 'backups'), { host: 'otherbox' });
    await other.createBackup();
    assert.equal(mgr.prune(1), 0);
    assert.equal(other.listBackups().filter(b => b.host === 'otherbox').length, 1);
    assert.equal(other.latest('otherbox')?.host, 'otherbox');
    assert.equal(mgr.latest('testbox')?.host, 'testbox');
  });

  it('pathFor rejects traversal, unknown names and the old plaintext files', () => {
    assert.equal(mgr.pathFor('../../etc/passwd'), null);
    assert.equal(mgr.pathFor('nope.db.age'), null);
    assert.equal(mgr.pathFor('ritsu-2026-11-13T00-00-00-000Z.db'), null);
    assert.equal(mgr.pathFor(fileName('testbox', 'daily', new Date(0))), null, 'a well-formed name that does not exist');
  });

  it('export includes your data but excludes secrets/tokens', () => {
    const exp = mgr.exportJson();
    assert.equal(exp.tables.memories.length, 1);
    assert.equal(exp.tables.agent_definitions !== undefined, true);
    assert.equal(exp.tables.mcp_tokens, undefined);
    assert.equal(exp.tables.plugin_secrets, undefined);
    assert.equal(exp.tables.oauth_clients, undefined);
  });

  it('the CLI path backs up from a read-only connection without running migrations', async () => {
    const ro = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const info = await createBackupFrom(ro, dbFile, join(tmp, 'backups'), 'testbox', 'daily', PW);
      assert.ok(mgr.pathFor(info.name));
    } finally { ro.close(); }
  });
});

describe('rehearse', () => {
  let tmp: string;
  before(() => { tmp = mkdtempSync(join(tmpdir(), 'ritsu-rh-')); });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('reports row counts before and after this build\'s migrations and cleans up', async () => {
    const dbFile = join(tmp, 'data', 'ritsu.db');
    const db = openDatabase(dbFile);
    db.prepare("INSERT INTO memories (agent_id, content, lineage_root_id) VALUES ('a', 'x', 0)").run();
    savePassword(join(tmp, 'data'), PW);
    const mgr = new BackupManager(db, dbFile, join(tmp, 'backups'), { host: 'h' });
    const info = await mgr.createBackup();

    // A database opened by the core alone lacks the memory backend's tables,
    // so the rehearsal's migrations add them: the schema changes.
    const report = await mgr.rehearse(info.name);
    assert.equal(report.backup, info.name);
    assert.equal(report.schema_changed, true);
    const memories = report.tables.find(t => t.name === 'memories');
    assert.deepEqual(memories, { name: 'memories', before: 1, after: 1 });
    assert.ok(report.tables.some(t => t.name === 'raw_records' && t.before === null && t.after === 0), 'a table the upgrade adds');
    assert.ok(report.schema.added.includes('table raw_records'), 'the diff names it');
    assert.deepEqual(report.schema.removed, []);
    assert.deepEqual(readdirSync(join(tmp, 'data')).filter(n => n.startsWith('.rehearse-')), [], 'scratch removed');

    // Once the live file carries that schema a rehearsal reports no change.
    migrateCopy(dbFile, []).close();
    const again = await mgr.rehearse('latest');
    assert.equal(again.schema_changed, true, 'the backup predates the migration, so it still changes');
    const fresh = await mgr.createBackup();
    const third = await mgr.rehearse(fresh.name);
    assert.equal(third.schema_changed, false);
    assert.deepEqual(third.schema, { added: [], removed: [], altered: [] });
    assert.equal(third.kept_at, undefined);
  });

  it('--keep leaves the migrated copy in place', async () => {
    const dbFile = join(tmp, 'keep', 'ritsu.db');
    openDatabase(dbFile).close();
    savePassword(join(tmp, 'keep'), PW);
    const mgr = new BackupManager(openDatabase(dbFile), dbFile, join(tmp, 'keep-backups'), { host: 'h' });
    const info = await mgr.createBackup();
    const report = await mgr.rehearse(info.name, true);
    assert.ok(report.kept_at && existsSync(report.kept_at));
  });

  it('a wrong password and a damaged backup fail at their stage', async () => {
    const dbFile = join(tmp, 'bad', 'ritsu.db');
    openDatabase(dbFile).close();
    savePassword(join(tmp, 'bad'), PW);
    const mgr = new BackupManager(openDatabase(dbFile), dbFile, join(tmp, 'bad-backups'), { host: 'h' });
    const info = await mgr.createBackup();
    await assert.rejects(rehearse(mgr.pathFor(info.name)!, 'wrong password for sure', [], join(tmp, 'bad')), WrongPassword);
    const junk = join(tmp, 'bad', 'ritsu-h-20260101T000000Z.db.age');
    writeFileSync(junk, 'nope');
    await assert.rejects(
      rehearse(junk, PW, [], join(tmp, 'bad')),
      (e: unknown) => e instanceof RehearsalError && e.stage === 'decrypt',
    );
  });
});

describe('preUpgrade', () => {
  let tmp: string;
  before(() => { tmp = mkdtempSync(join(tmpdir(), 'ritsu-pu-')); });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('is a no-op on a fresh install', async () => {
    assert.equal(await preUpgrade({ dbPath: join(tmp, 'none', 'ritsu.db'), dir: join(tmp, 'b'), host: 'h', plugins: [] }), null);
  });

  it('writes one pre-upgrade copy when the schema would change, and only one', async () => {
    const dataDir = join(tmp, 'data');
    const dbPath = join(dataDir, 'ritsu.db');
    const dir = join(tmp, 'backups');
    // Core schema only: this build's boot adds the memory backend's tables.
    openDatabase(dbPath).close();

    await assert.rejects(preUpgrade({ dbPath, dir, host: 'h', plugins: [] }), /no backup password is set/);
    assert.equal(existsSync(dir), false, 'nothing written without a password');

    savePassword(dataDir, PW);
    const info = await preUpgrade({ dbPath, dir, host: 'h', plugins: [] });
    assert.ok(info);
    assert.equal(info.kind, 'pre-upgrade');
    assert.ok(existsSync(join(dir, info.name)));
    assert.ok(existsSync(join(dataDir, 'pre-upgrade.json')));
    // The live file was not migrated by the check.
    const live = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(live.prepare("SELECT 1 x FROM sqlite_master WHERE name = 'raw_records'").get(), undefined);
    live.close();

    // A second start of the same build before the migration lands: the copy stands.
    assert.equal(await preUpgrade({ dbPath, dir, host: 'h', plugins: [] }), null);
    assert.equal(readdirSync(dir).length, 1);

    // After the real boot migrated it, nothing is pending.
    migrateCopy(dbPath, []).close();
    assert.equal(await preUpgrade({ dbPath, dir, host: 'h', plugins: [] }), null);
    assert.deepEqual(readdirSync(dataDir).filter(n => n.startsWith('.')), [], 'no scratch left behind');
  });
});

describe('restore', () => {
  let tmp: string;
  before(() => { tmp = mkdtempSync(join(tmpdir(), 'ritsu-rs-')); });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('swaps the backup in and keeps the previous database aside', async () => {
    const dataDir = join(tmp, 'data');
    const dbPath = join(dataDir, 'ritsu.db');
    const db = openDatabase(dbPath);
    db.prepare("INSERT INTO memories (agent_id, content, lineage_root_id) VALUES ('a', 'keep me', 0)").run();
    savePassword(dataDir, PW);
    const mgr = new BackupManager(db, dbPath, join(tmp, 'backups'), { host: 'h' });
    const info = await mgr.createBackup();
    db.prepare("INSERT INTO memories (agent_id, content, lineage_root_id) VALUES ('a', 'after the backup', 0)").run();
    db.close();

    const r = await restore(mgr.pathFor(info.name)!, dbPath, PW);
    assert.equal(r.memories, 1);
    assert.ok(r.previous_saved_to?.includes('pre-restore-'));
    assert.ok(existsSync(join(r.previous_saved_to!, 'ritsu.db')));
    const live = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal((live.prepare('SELECT count(*) c FROM memories').get() as { c: number }).c, 1, 'the row written after the backup is gone');
    live.close();
    assert.deepEqual(readdirSync(dataDir).filter(n => n.startsWith('.restore-')), []);
    assert.equal(existsSync(join(dataDir, 'ritsu.db-wal')), false, 'no stale write-ahead log beside the restored file');
  });

  it('refuses the wrong password and a file that is not a ritsu database', async () => {
    const dataDir = join(tmp, 'd2');
    const dbPath = join(dataDir, 'ritsu.db');
    openDatabase(dbPath).close();
    savePassword(dataDir, PW);
    const mgr = new BackupManager(openDatabase(dbPath), dbPath, join(tmp, 'b2'), { host: 'h' });
    const info = await mgr.createBackup();
    await assert.rejects(restore(mgr.pathFor(info.name)!, dbPath, 'definitely not the one'), WrongPassword);
    assert.ok(existsSync(dbPath), 'the live database is still there');
  });

  it('a start with no database but a pre-restore folder refuses to run on an empty file', () => {
    const dataDir = join(tmp, 'd3');
    mkdirSync(join(dataDir, 'pre-restore-20260101T000000Z'), { recursive: true });
    writeFileSync(join(dataDir, 'pre-restore-20260101T000000Z', 'ritsu.db'), '');
    assert.throws(() => checkNotStranded(join(dataDir, 'ritsu.db')), /moved aside/);
    writeFileSync(join(dataDir, 'ritsu.db'), '');
    checkNotStranded(join(dataDir, 'ritsu.db'));
  });
});
