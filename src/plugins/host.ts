import express, { type Express } from 'express';
import type { Db, Stmt } from '../db.js';
import { logger } from '../util/log.js';
import type { SecretStore } from '../auth/secret-store.js';
import type { Plugin, PluginContext, PluginDb, PluginLogger, PluginManifest, PluginSecrets, PluginToolDef } from './types.js';

/**
 * A table-name-prefix helper, NOT a security boundary. `prepare`/`exec` pass
 * raw SQL straight to the shared core DB — a plugin CAN reach core tables if it
 * writes SQL to. Isolation today rests entirely on plugins being first-party,
 * compiled-in code (no dynamic/third-party loader exists). Before that ever
 * changes, this needs real enforcement (per-plugin DB file or a SQL authorizer).
 */
export class ScopedDb implements PluginDb {
  readonly tablesUsed = new Set<string>();
  constructor(private readonly db: Db, private readonly ns: string) {}
  table(name: string): string {
    const t = `plugin_${this.ns}_${name}`;
    this.tablesUsed.add(t);
    return t;
  }
  prepare(sql: string): Stmt { return this.db.prepare(sql); }
  exec(sql: string): void { this.db.exec(sql); }
  transaction<T>(fn: () => T): () => T { return this.db.transaction(fn); }
}

function scopedLogger(id: string): PluginLogger {
  const wrap = (level: 'info' | 'warn' | 'error' | 'debug') =>
    (msg: string, meta?: Record<string, unknown>) => logger[level](`plugin.${id}.${msg}`, { plugin: id, ...meta });
  return { info: wrap('info'), warn: wrap('warn'), error: wrap('error'), debug: wrap('debug') };
}

/** Secret accessor bound to ONE plugin's namespace in the core SecretStore, so
 *  a plugin can only touch its own secrets. Values are for in-process handler
 *  use; list() returns names only. */
function scopedSecrets(secrets: SecretStore, id: string): PluginSecrets {
  const ns = `plugin:${id}`;
  return {
    get: (name) => secrets.get(ns, name),
    set: (name, value) => secrets.set(ns, name, value),
    has: (name) => secrets.has(ns, name),
    delete: (name) => secrets.delete(ns, name),
    list: () => secrets.list(ns).map(m => m.name),
  };
}

/** Built-in MCP tool-group namespaces a plugin id may not shadow — assembleMcp
 *  is last-writer-wins, and plugins assemble after built-ins, so a plugin named
 *  'memory'/'email'/etc. would overwrite that group's server. */
const RESERVED_NAMESPACES = new Set(['memory', 'agent_comms', 'agent_admin', 'agent_monitor', 'email', 'social']);

export interface PluginManifestOut extends PluginManifest {
  assets?: { js?: string; css?: string };
  tables: string[];
  mcpTools: string[];
  enabled: boolean;
  installed_at?: number;
  updated_at?: number;
}

interface RegistryRow {
  version: string;
  tables: string;
  enabled: number;
  installed_at: number;
  updated_at: number;
}

export class PluginHost {
  private readonly plugins: Plugin[] = [];
  private readonly pluginTools = new Map<string, PluginToolDef[]>();

  constructor(private readonly db: Db, private readonly secrets: SecretStore) {}

  register(plugin: Plugin): void {
    const id = plugin.manifest.id;
    if (RESERVED_NAMESPACES.has(id)) {
      throw new Error(`plugin id '${id}' is reserved for a built-in tool group`);
    }
    if (this.plugins.some(p => p.manifest.id === id)) {
      throw new Error(`plugin '${id}' already registered`);
    }
    const scoped = new ScopedDb(this.db, id);
    if (plugin.migrate) plugin.migrate(scoped);
    if (plugin.defineTools) {
      const tools: PluginToolDef[] = [];
      plugin.defineTools({
        db: new ScopedDb(this.db, id),
        logger: scopedLogger(id),
        secrets: scopedSecrets(this.secrets, id),
        tool: (d) => tools.push(d),
      });
      this.pluginTools.set(id, tools);
    }
    this.plugins.push(plugin);
    this.recordRegistry(plugin, [...scoped.tablesUsed]);
  }

  toolsFor(id: string): PluginToolDef[] {
    return this.pluginTools.get(id) ?? [];
  }

  private recordRegistry(plugin: Plugin, tables: string[]): void {
    const { id, name, version } = plugin.manifest;
    const prior = this.db.prepare('SELECT version FROM plugin_registry WHERE id = ?').get(id) as { version: string } | undefined;
    if (!prior) {
      this.db.prepare('INSERT INTO plugin_registry (id, name, version, tables) VALUES (?, ?, ?, ?)')
        .run(id, name, version, JSON.stringify(tables));
      logger.info('plugin.installed', { id, version, tables: tables.length });
      return;
    }
    this.db.prepare("UPDATE plugin_registry SET name = ?, version = ?, tables = ?, updated_at = strftime('%s','now') WHERE id = ?")
      .run(name, version, JSON.stringify(tables), id);
    logger[prior.version === version ? 'debug' : 'info'](
      prior.version === version ? 'plugin.registered' : 'plugin.updated',
      { id, from: prior.version, to: version },
    );
  }

  isEnabled(id: string): boolean {
    const row = this.db.prepare('SELECT enabled FROM plugin_registry WHERE id = ?').get(id) as { enabled: number } | undefined;
    return !row || row.enabled === 1;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const r = this.db
      .prepare("UPDATE plugin_registry SET enabled = ?, updated_at = strftime('%s','now') WHERE id = ?")
      .run(enabled ? 1 : 0, id);
    if (r.changes > 0) logger.info('plugin.enabled-changed', { id, enabled });
    return r.changes > 0;
  }

  uninstall(id: string): boolean {
    const row = this.db.prepare('SELECT tables FROM plugin_registry WHERE id = ?').get(id) as { tables: string } | undefined;
    if (!row) return false;
    const tables = JSON.parse(row.tables) as string[];
    for (const t of tables) {
      if (/^plugin_[a-z0-9_]+$/i.test(t)) this.db.exec(`DROP TABLE IF EXISTS "${t}"`);
    }
    this.db.prepare('DELETE FROM plugin_registry WHERE id = ?').run(id);
    logger.info('plugin.uninstalled', { id, dropped: tables.length });
    return true;
  }

  mountApi(app: Express): void {
    for (const plugin of this.plugins) {
      if (!plugin.register) continue;
      const id = plugin.manifest.id;
      const base = `/admin/api/plugins/${id}`;
      const ctx: PluginContext = {
        id,
        db: new ScopedDb(this.db, id),
        logger: scopedLogger(id),
        secrets: scopedSecrets(this.secrets, id),
        route: (method, path, handler) => {
          app[method](base + path, (req, res) => {
            if (!this.isEnabled(id)) { res.status(404).json({ error: `plugin '${id}' is disabled` }); return; }
            return handler(req, res);
          });
        },
      };
      plugin.register(ctx);
    }
  }

  mountAssets(app: Express): void {
    for (const plugin of this.plugins) {
      if (!plugin.assetsDir) continue;
      const id = plugin.manifest.id;
      app.use(
        `/admin/plugins/${id}`,
        (_req, res, next) => { if (this.isEnabled(id)) { next(); return; } res.status(404).end(); },
        express.static(plugin.assetsDir, {
          index: false,
          setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache'); },
        }),
      );
    }
  }

  manifests(): PluginManifestOut[] {
    return this.plugins.map(p => {
      const row = this.db
        .prepare('SELECT version, tables, enabled, installed_at, updated_at FROM plugin_registry WHERE id = ?')
        .get(p.manifest.id) as RegistryRow | undefined;
      return {
        ...p.manifest,
        assets: p.assetsDir
          ? { js: `/admin/plugins/${p.manifest.id}/app.js`, css: `/admin/plugins/${p.manifest.id}/app.css` }
          : undefined,
        tables: row ? (JSON.parse(row.tables) as string[]) : [],
        mcpTools: this.toolsFor(p.manifest.id).map(t => `mcp__${p.manifest.id}__${t.name}`),
        enabled: row ? row.enabled === 1 : true,
        installed_at: row?.installed_at,
        updated_at: row?.updated_at,
      };
    });
  }
}
