import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openDatabase } from '../db.js';
import { ScopedDb, PluginHost } from '../plugins/host.js';
import type { PluginDb } from '../plugins/types.js';
import { projectsPlugin } from '../plugins/projects/plugin.js';
import { ProjectStore, TaskStore } from '../plugins/projects/store.js';
import { buildPluginToolServer } from '../plugins/agent-tools.js';

function count(db: ReturnType<typeof openDatabase>, sql: string, ...p: unknown[]): number {
  return (db.prepare(sql).get(...p) as { c: number }).c;
}

function freshDb(): PluginDb {
  const db = new ScopedDb(openDatabase(':memory:'), 'projects');
  projectsPlugin.migrate?.(db);
  return db;
}

describe('projects plugin — namespaced tables', () => {
  it('creates tables under the plugin_projects_ namespace', () => {
    const db = freshDb();
    assert.equal(db.table('projects'), 'plugin_projects_projects');
    assert.equal(db.table('tasks'), 'plugin_projects_tasks');
    assert.doesNotThrow(() => db.prepare(`SELECT * FROM ${db.table('projects')}`).all());
  });
});

describe('ProjectStore (scoped)', () => {
  let store: ProjectStore;
  beforeEach(() => { store = new ProjectStore(freshDb()); });

  it('creates with defaults and lists case-insensitively', () => {
    store.upsert({ id: 'zeta', name: 'zeta' });
    const a = store.upsert({ id: 'alpha', name: 'Alpha' });
    assert.equal(a.enabled, true);
    assert.equal(a.working_dir, '');
    assert.deepEqual(store.list().map(p => p.id), ['alpha', 'zeta']);
  });

  it('upsert replaces in place, preserving created_at', () => {
    const first = store.upsert({ id: 'p', name: 'P', working_dir: '/a' });
    const upd = store.upsert({ id: 'p', name: 'P2', working_dir: '/b', enabled: false });
    assert.equal(upd.name, 'P2');
    assert.equal(upd.enabled, false);
    assert.equal(upd.created_at, first.created_at);
    assert.equal(store.list().length, 1);
  });

  it('delete removes by id', () => {
    store.upsert({ id: 'gone', name: 'Gone' });
    assert.equal(store.delete('gone'), true);
    assert.equal(store.delete('gone'), false);
  });
});

describe('TaskStore (scoped)', () => {
  let db: PluginDb;
  let tasks: TaskStore;
  beforeEach(() => { db = freshDb(); tasks = new TaskStore(db); });

  it('appends per-project positions with backlog default', () => {
    const a = tasks.create({ project_id: 'alpha', title: 'a1' });
    const b = tasks.create({ project_id: 'alpha', title: 'a2' });
    const c = tasks.create({ project_id: 'beta', title: 'b1' });
    assert.equal(a.status, 'backlog');
    assert.equal(a.position, 1);
    assert.equal(b.position, 2);
    assert.equal(c.position, 1);
  });

  it('lists all by project then position, and filters', () => {
    tasks.create({ project_id: 'beta', title: 'b1' });
    tasks.create({ project_id: 'alpha', title: 'a1' });
    assert.deepEqual(tasks.list().map(t => t.title), ['a1', 'b1']);
    assert.deepEqual(tasks.listFor('alpha').map(t => t.title), ['a1']);
  });

  it('update patches status only; missing task returns null', () => {
    const t = tasks.create({ project_id: 'alpha', title: 'x', detail: 'note' });
    const u = tasks.update(t.id, { status: 'doing' });
    assert.equal(u?.status, 'doing');
    assert.equal(u?.detail, 'note');
    assert.equal(tasks.update(999, { status: 'done' }), null);
  });

  it('deleteForProject clears one project', () => {
    tasks.create({ project_id: 'alpha', title: 'a1' });
    tasks.create({ project_id: 'alpha', title: 'a2' });
    tasks.create({ project_id: 'beta', title: 'b1' });
    assert.equal(tasks.deleteForProject('alpha'), 2);
    assert.deepEqual(tasks.list().map(t => t.title), ['b1']);
  });
});

describe('PluginHost registry + version + uninstall', () => {
  it('records version and owned tables on install', () => {
    const db = openDatabase(':memory:');
    const host = new PluginHost(db);
    host.register(projectsPlugin);
    const m = host.manifests().find(x => x.id === 'projects');
    assert.ok(m);
    assert.equal(m.version, '1.0.0');
    assert.equal(m.enabled, true);
    assert.deepEqual([...m.tables].sort(), ['plugin_projects_projects', 'plugin_projects_tasks']);
    assert.equal((db.prepare('SELECT version FROM plugin_registry WHERE id = ?').get('projects') as { version: string }).version, '1.0.0');
  });

  it('re-registering a bumped version updates in place, preserving install time', () => {
    const db = openDatabase(':memory:');
    new PluginHost(db).register(projectsPlugin);
    const first = db.prepare('SELECT installed_at FROM plugin_registry WHERE id = ?').get('projects') as { installed_at: number };
    const bumped = { ...projectsPlugin, manifest: { ...projectsPlugin.manifest, version: '1.1.0' } };
    new PluginHost(db).register(bumped);
    const after = db.prepare('SELECT installed_at, version FROM plugin_registry WHERE id = ?').get('projects') as { installed_at: number; version: string };
    assert.equal(after.version, '1.1.0');
    assert.equal(after.installed_at, first.installed_at);
    assert.equal(count(db, 'SELECT count(*) c FROM plugin_registry'), 1);
  });

  it('uninstall drops exactly the plugin tables + registry row, never core', () => {
    const db = openDatabase(':memory:');
    const host = new PluginHost(db);
    host.register(projectsPlugin);
    assert.doesNotThrow(() => db.prepare('SELECT * FROM plugin_projects_projects').all());
    const coreTables = count(db, "SELECT count(*) c FROM sqlite_master WHERE type='table' AND name IN ('mcp_tokens','agent_definitions','plugin_registry')");
    assert.equal(host.uninstall('projects'), true);
    assert.equal(count(db, "SELECT count(*) c FROM sqlite_master WHERE name LIKE 'plugin_projects_%'"), 0);
    assert.equal(count(db, 'SELECT count(*) c FROM plugin_registry WHERE id = ?', 'projects'), 0);
    assert.equal(count(db, "SELECT count(*) c FROM sqlite_master WHERE type='table' AND name IN ('mcp_tokens','agent_definitions','plugin_registry')"), coreTables);
    assert.equal(host.uninstall('projects'), false);
  });
});

describe('PluginHost enable/disable', () => {
  it('toggles enabled state, reflected in isEnabled + manifests', () => {
    const db = openDatabase(':memory:');
    const host = new PluginHost(db);
    host.register(projectsPlugin);
    assert.equal(host.isEnabled('projects'), true);
    assert.equal(host.setEnabled('projects', false), true);
    assert.equal(host.isEnabled('projects'), false);
    assert.equal(host.manifests().find(x => x.id === 'projects')?.enabled, false);
    assert.equal(host.setEnabled('projects', true), true);
    assert.equal(host.isEnabled('projects'), true);
    assert.equal(host.setEnabled('does-not-exist', false), false);
  });

  it('disable is non-destructive; uninstall is what drops tables', () => {
    const db = openDatabase(':memory:');
    const host = new PluginHost(db);
    host.register(projectsPlugin);
    host.setEnabled('projects', false);
    assert.doesNotThrow(() => db.prepare('SELECT * FROM plugin_projects_projects').all());
    assert.equal(count(db, "SELECT count(*) c FROM sqlite_master WHERE name LIKE 'plugin_projects_%'"), 2);
  });
});

describe('plugin_registry migration (existing DBs)', () => {
  it('backfills enabled on a plugin_registry that predates the column', () => {
    const path = join(tmpdir(), `ritsu-mig-${process.pid}-${Date.now()}.db`);
    try {
      const raw = new DatabaseSync(path);
      raw.exec("CREATE TABLE plugin_registry (id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL DEFAULT '', tables TEXT NOT NULL DEFAULT '[]', installed_at INTEGER, updated_at INTEGER)");
      raw.exec("INSERT INTO plugin_registry (id, name, version) VALUES ('projects', 'Projects', '1.0.0')");
      raw.close();
      const db = openDatabase(path);
      const cols = (db.prepare('PRAGMA table_info(plugin_registry)').all() as { name: string }[]).map(c => c.name);
      assert.ok(cols.includes('enabled'), 'enabled column added');
      assert.equal((db.prepare('SELECT enabled FROM plugin_registry WHERE id = ?').get('projects') as { enabled: number }).enabled, 1);
      db.close();
    } finally {
      rmSync(path, { force: true });
    }
  });
});

describe('projects plugin — agent tools (MCP surface)', () => {
  it('declares list/create/update tools; mutations need approval; manifest lists them', () => {
    const db = openDatabase(':memory:');
    const host = new PluginHost(db);
    host.register(projectsPlugin);
    const tools = host.toolsFor('projects');
    assert.deepEqual(tools.map(t => t.name), ['list_projects', 'create_project', 'list_tasks', 'create_task', 'update_task']);
    const by = Object.fromEntries(tools.map(t => [t.name, t]));
    assert.equal(by.list_projects.needsApproval, undefined);
    assert.equal(by.create_project.needsApproval, true);
    assert.equal(by.create_task.needsApproval, true);
    assert.equal(by.update_task.needsApproval, true);
    assert.deepEqual(host.manifests().find(x => x.id === 'projects')?.mcpTools, [
      'mcp__projects__list_projects', 'mcp__projects__create_project', 'mcp__projects__list_tasks',
      'mcp__projects__create_task', 'mcp__projects__update_task',
    ]);
  });

  it('tool handlers operate on the plugin scoped data', async () => {
    const db = openDatabase(':memory:');
    const host = new PluginHost(db);
    host.register(projectsPlugin);
    const by = Object.fromEntries(host.toolsFor('projects').map(t => [t.name, t]));
    new ProjectStore(new ScopedDb(db, 'projects')).upsert({ id: 'alpha', name: 'Alpha' });
    const created = await by.create_task.handler({ project_id: 'alpha', title: 'ship' }, { agentId: 'a1' });
    assert.match(created.content[0].text, /created task/);
    const listed = await by.list_tasks.handler({ project: 'alpha' }, { agentId: 'a1' });
    assert.match(listed.content[0].text, /ship/);
  });

  it('buildPluginToolServer assembles an SDK server without throwing', () => {
    const db = openDatabase(':memory:');
    const host = new PluginHost(db);
    host.register(projectsPlugin);
    assert.doesNotThrow(() => buildPluginToolServer('projects', host.toolsFor('projects'), 'a1', null));
  });
});

describe('plugin security hardening', () => {
  it('rejects a plugin id that shadows a built-in tool group', () => {
    const host = new PluginHost(openDatabase(':memory:'));
    const shadow = { ...projectsPlugin, manifest: { ...projectsPlugin.manifest, id: 'memory' } };
    assert.throws(() => host.register(shadow), /reserved/);
  });

  it('flags read tools untrustedOutput (fenced) but not write confirmations', () => {
    const host = new PluginHost(openDatabase(':memory:'));
    host.register(projectsPlugin);
    const by = Object.fromEntries(host.toolsFor('projects').map(t => [t.name, t]));
    assert.equal(by.list_projects.untrustedOutput, true);
    assert.equal(by.list_tasks.untrustedOutput, true);
    assert.equal(by.create_task.untrustedOutput, undefined);
    assert.equal(by.create_project.untrustedOutput, undefined);
  });
})
