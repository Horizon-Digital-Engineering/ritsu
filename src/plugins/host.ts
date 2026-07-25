import express, { type Express } from 'express';
import type { Db, Stmt } from '../db.js';
import { logger } from '../util/log.js';
import type { SecretStore } from '../auth/secret-store.js';
import type { Plugin, PluginAgentSeed, PluginContext, PluginDb, PluginLogger, PluginManifest, PluginSecrets, PluginToolDef } from './types.js';
import { resolveExtractor } from '../ingestion/extractors.js';

/**
 * Textual guard: every table a plugin statement references must be one of that
 * plugin's own `plugin_<ns>_*` tables. Rejects the obvious escapes — core-table
 * names, other plugins' prefixes, `sqlite_*` schema tables, SQL comments (used
 * to hide a table ref), and schema/cross-database verbs. It is defense-in-depth,
 * NOT a kernel-enforced sandbox: a determined hostile plugin could still craft
 * SQL a text scan misses, so a dynamic/third-party loader still needs true
 * isolation (a per-plugin DB file). What it DOES buy today: the model-reachable
 * surface (tool + route handlers) can't reach `agent_definitions`, `mcp_tokens`,
 * `plugin_secrets`, or a peer plugin's tables even by accident or casual abuse.
 */
export function assertScopedSql(sql: string, ns: string): void {
  const prefix = `plugin_${ns}_`;
  if (/--|\/\*|\*\//.test(sql)) throw new Error(`ScopedDb(${ns}): SQL comments are not allowed`);
  const banned = sql.match(/\b(ATTACH|DETACH|PRAGMA|VACUUM|REINDEX)\b/i);
  if (banned) throw new Error(`ScopedDb(${ns}): '${banned[1].toUpperCase()}' is not allowed`);
  // Drop single-quoted string literals so their contents can't be mistaken for
  // (or hide) a table identifier. Double-quoted identifiers stay — those ARE
  // names and must be validated.
  const stripped = sql.replace(/'(?:[^']|'')*'/g, "''");
  if (/\bsqlite_/i.test(stripped)) throw new Error(`ScopedDb(${ns}): sqlite_* schema tables are off-limits`);
  // Normalize DDL modifiers so `TABLE <name>` is scannable.
  const norm = stripped
    .replace(/\bif\s+not\s+exists\b/gi, '')
    .replace(/\bif\s+exists\b/gi, '')
    .replace(/\b(?:temp|temporary)\s+table\b/gi, 'table');
  // Keywords that can follow FROM/INTO/UPDATE in valid SQL without naming a
  // table (e.g. the `DO UPDATE SET` of an upsert) — not table references.
  const NON_TABLE = new Set(['set', 'select', 'values']);
  const re = /\b(?:from|join|into|update|table)\s+("?)([A-Za-z_][A-Za-z0-9_]*)\1/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm)) !== null) {
    const name = m[2];
    if (NON_TABLE.has(name.toLowerCase())) continue;
    if (!name.startsWith(prefix)) {
      throw new Error(`ScopedDb(${ns}): may only reference its own tables (${prefix}*), not '${name}'`);
    }
  }
}

/**
 * Per-plugin DB handle. `table(name)` namespaces to `plugin_<ns>_<name>`.
 *
 * When `guarded` (the handle given to tool + route handlers — the surface an
 * agent/model can drive), every prepare/exec is checked by assertScopedSql so a
 * plugin statement can only touch its own tables. The install-time `migrate()`
 * handle is UNguarded: it runs once at registration under operator control (and
 * legitimately imports legacy data), the same trust level as the rest of boot.
 * See assertScopedSql for the (honest) limits of a textual guard.
 */
export class ScopedDb implements PluginDb {
  readonly tablesUsed = new Set<string>();
  constructor(private readonly db: Db, private readonly ns: string, private readonly guarded = false) {}
  table(name: string): string {
    const t = `plugin_${this.ns}_${name}`;
    this.tablesUsed.add(t);
    return t;
  }
  prepare(sql: string): Stmt {
    if (this.guarded) assertScopedSql(sql, this.ns);
    return this.db.prepare(sql);
  }
  exec(sql: string): void {
    if (this.guarded) assertScopedSql(sql, this.ns);
    this.db.exec(sql);
  }
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
  /** Lightweight info about a recommended agent preset (if the plugin ships
   *  one), for the "load agent" button. Full seed via agentSeed(). */
  agent?: { id: string; name: string } | null;
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
      // Guarded handle: tool handlers run in response to agent/model actions.
      plugin.defineTools({
        db: new ScopedDb(this.db, id, true),
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

  /** The recommended agent preset a plugin ships (if any), for the "load
   *  agent" flow. Full config incl. system_prompt — server-side only. */
  agentSeed(id: string): PluginAgentSeed | undefined {
    return this.plugins.find(p => p.manifest.id === id)?.agent;
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
        // Guarded handle: route handlers serve HTTP requests (operator UI).
        db: new ScopedDb(this.db, id, true),
        logger: scopedLogger(id),
        secrets: scopedSecrets(this.secrets, id),
        extractor: resolveExtractor(this.secrets),
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
        agent: p.agent ? { id: p.agent.id ?? `${p.manifest.id}-assistant`, name: p.agent.name } : null,
      };
    });
  }
}
