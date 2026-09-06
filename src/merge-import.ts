/**
 * Merge a CURRENT-format JSON export into the live database.
 *
 * This understands exactly one shape: what `exportJson()` writes today. It
 * refuses anything else — wrong format stamp, tables with columns the live
 * schema doesn't have.
 *
 * Every integer id is remapped on insert, so nothing that exists is ever
 * overwritten; FKs are re-pointed through the maps (message parents,
 * attachment links, memory supersession/lineage, project filings).
 * Credentials NEVER merge: tokens, API keys, audit rows, channel configs,
 * settings — the live side keeps its own.
 */
import type { Db } from './db.js';
import { EXPORT_FORMAT, type ExportFile } from './backup.js';

/** Tables that must never cross installs. Everything credential- or
 *  install-identity-shaped, plus operator settings (live wins). */
const NEVER_MERGE = new Set([
  'mcp_tokens', 'mcp_token_usage', 'api_keys', 'admin_audit', 'plugin_secrets',
  'oauth_clients', 'oauth_authorize_requests', 'oauth_authz_codes',
  'oauth_access_tokens', 'oauth_refresh_tokens',
  'channels', 'settings', 'schema_meta',
]);

export interface MergeOptions {
  /** Agent ids to bring over. Empty/omitted = every agent in the export. */
  agents?: string[];
  /** Agent ids whose LIVE definition should be overwritten by the export's. */
  replaceAgents?: string[];
  /** Report only — every write happens in a transaction that rolls back. */
  dryRun?: boolean;
}

export interface TableReport {
  inserted: number;
  skipped: number;
}

export interface MergeReport {
  tables: Record<string, TableReport>;
  skippedTables: string[];
  skippedAgents: string[];
  notes: string[];
  dryRun: boolean;
}

type Row = Record<string, unknown>;

function decodeBlob(v: unknown): unknown {
  if (v && typeof v === 'object' && '$blob' in v) {
    return new Uint8Array(Buffer.from(String((v as { $blob: string }).$blob), 'base64'));
  }
  return v === undefined ? null : v;
}

function tableColumns(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(c => c.name);
}

function tableExists(db: Db, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table) !== undefined;
}

class Merger {
  readonly report: MergeReport = {
    tables: Object.create(null) as Record<string, TableReport>,
    skippedTables: [], skippedAgents: [], notes: [], dryRun: false,
  };
  /** old integer id → new integer id, per remapped table. */
  private readonly idMaps = new Map<string, Map<number, number>>();
  private readonly selected: Set<string> | null;

  constructor(
    private readonly file: ExportFile,
    private readonly live: Db,
    private readonly opts: MergeOptions,
  ) {
    this.selected = opts.agents?.length ? new Set(opts.agents) : null;
  }

  private wantsAgent(id: unknown): boolean { return !this.selected || this.selected.has(String(id)); }

  private table(table: string): TableReport {
    // The report is keyed by names from an uploaded file — a null-prototype
    // object keeps "__proto__" and friends inert data instead of pollution.
    this.report.tables[table] ??= { inserted: 0, skipped: 0 };
    return this.report.tables[table];
  }

  /** Rows of an export table, id-ordered so parents precede children. */
  private rows(table: string): Row[] {
    const raw = this.file.tables[table];
    if (!Array.isArray(raw)) return [];
    const rows = raw.map(r => {
      // Keys come from an uploaded file — a null-prototype target makes
      // "__proto__" a plain own property instead of prototype pollution.
      const out: Row = Object.create(null) as Row;
      for (const [k, v] of Object.entries(r as Row)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        out[k] = decodeBlob(v);
      }
      return out;
    });
    if (rows.length && typeof rows[0].id === 'number') rows.sort((a, b) => Number(a.id) - Number(b.id));
    return rows;
  }

  private has(table: string): boolean {
    const raw = this.file.tables[table];
    return Array.isArray(raw) && raw.length > 0;
  }

  /** A column the live schema doesn't have means the file is not a current
   *  export — refused, not papered over. */
  private liveColumnsStrict(table: string): Set<string> {
    const liveCols = new Set(tableColumns(this.live, table));
    const first = (this.file.tables[table] as Row[])[0];
    const unknown = Object.keys(first).filter(c => !liveCols.has(c));
    if (unknown.length) {
      throw new Error(
        `table '${table}' carries column(s) this schema does not have: ${unknown.join(', ')} — not a current-format export`,
      );
    }
    return liveCols;
  }

  private insert(table: string, liveCols: Set<string>, row: Row): number {
    const cols = Object.keys(row).filter(c => liveCols.has(c));
    const colList = cols.map(c => '"' + c + '"').join(', ');
    const holes = cols.map(() => '?').join(', ');
    const r = this.live.prepare(`INSERT INTO "${table}" (${colList}) VALUES (${holes})`)
      .run(...(cols.map(c => row[c]) as never[]));
    return Number(r.lastInsertRowid);
  }

  private map(table: string): Map<number, number> {
    let m = this.idMaps.get(table);
    if (!m) { m = new Map(); this.idMaps.set(table, m); }
    return m;
  }

  private remapped(table: string, v: unknown): unknown {
    if (v === null || v === undefined) return v;
    return this.map(table).get(Number(v)) ?? v;
  }

  mergeDefinitions(): void {
    if (!this.has('agent_definitions')) return;
    const rep = this.table('agent_definitions');
    const liveCols = this.liveColumnsStrict('agent_definitions');
    const replace = new Set(this.opts.replaceAgents ?? []);
    for (const row of this.rows('agent_definitions')) {
      const id = row.id as string;
      if (!this.wantsAgent(id)) continue;
      const exists = this.live.prepare('SELECT 1 FROM agent_definitions WHERE id = ?').get(id) !== undefined;
      if (exists && !replace.has(id)) {
        rep.skipped++;
        this.report.skippedAgents.push(id);
        continue;
      }
      if (exists) this.live.prepare('DELETE FROM agent_definitions WHERE id = ?').run(id);
      this.insert('agent_definitions', liveCols, row);
      rep.inserted++;
    }
  }

  mergeWorkspaces(): void {
    if (!this.has('agent_workspaces')) return;
    const rep = this.table('agent_workspaces');
    const liveCols = this.liveColumnsStrict('agent_workspaces');
    for (const row of this.rows('agent_workspaces')) {
      if (!this.wantsAgent(row.agent_id)) continue;
      const dupe = this.live.prepare('SELECT 1 FROM agent_workspaces WHERE agent_id = ? AND path = ?')
        .get(row.agent_id, row.path) !== undefined;
      if (dupe) { rep.skipped++; continue; }
      const { id: _id, ...rest } = row;
      this.insert('agent_workspaces', liveCols, rest);
      rep.inserted++;
    }
  }

  mergeMemories(): void {
    if (this.has('memories')) {
      const rep = this.table('memories');
      const liveCols = this.liveColumnsStrict('memories');
      const rows = this.rows('memories').filter(r => this.wantsAgent(r.agent_id));
      // Two passes: insert with lineage/supersession still pointing at OLD
      // ids, then re-point through the map once every new id exists.
      for (const row of rows) {
        const { id: oldId, ...rest } = row;
        this.map('memories').set(Number(oldId), this.insert('memories', liveCols, rest));
        rep.inserted++;
      }
      const fix = this.live.prepare('UPDATE memories SET superseded_by = ?, lineage_root_id = ? WHERE id = ?');
      for (const row of rows) {
        fix.run(
          this.remapped('memories', row.superseded_by),
          // lineage_root_id 0 is the "am my own root" sentinel — keep it.
          (Number(row.lineage_root_id) ? this.remapped('memories', row.lineage_root_id) : 0),
          this.map('memories').get(Number(row.id))!,
        );
      }
    }
    this.mergeRawRecords();
  }

  private mergeRawRecords(): void {
    if (!this.has('raw_records') || !tableExists(this.live, 'raw_records')) return;
    const rep = this.table('raw_records');
    const liveCols = this.liveColumnsStrict('raw_records');
    for (const row of this.rows('raw_records')) {
      // UUID keys are collision-safe across installs; a duplicate means a
      // re-run, so skip rather than error.
      const dupe = this.live.prepare('SELECT 1 FROM raw_records WHERE id = ?').get(row.id) !== undefined;
      if (dupe) { rep.skipped++; continue; }
      this.insert('raw_records', liveCols, row);
      rep.inserted++;
    }
  }

  mergeConversations(): void {
    if (!this.has('conversations')) return;
    this.mergeProjects();
    const rep = this.table('conversations');
    const liveCols = this.liveColumnsStrict('conversations');
    for (const row of this.rows('conversations')) {
      if (!this.wantsAgent(row.agent_id)) continue;
      const { id: oldId, ...rest } = row;
      if ('project_id' in rest) rest.project_id = this.remapped('agent_projects', rest.project_id);
      this.map('conversations').set(Number(oldId), this.insert('conversations', liveCols, rest));
      rep.inserted++;
    }
    this.mergeMessages();
    this.mergeAttachments();
  }

  private mergeProjects(): void {
    if (!this.has('agent_projects')) return;
    const rep = this.table('agent_projects');
    const liveCols = this.liveColumnsStrict('agent_projects');
    for (const row of this.rows('agent_projects')) {
      if (!this.wantsAgent(row.agent_id)) continue;
      const { id: oldId, ...rest } = row;
      this.map('agent_projects').set(Number(oldId), this.insert('agent_projects', liveCols, rest));
      rep.inserted++;
    }
    if (this.has('agent_project_files')) {
      const frep = this.table('agent_project_files');
      const fcols = this.liveColumnsStrict('agent_project_files');
      for (const row of this.rows('agent_project_files')) {
        if (!this.wantsAgent(row.agent_id)) continue;
        const { id: _id, ...rest } = row;
        if ('project_id' in rest) rest.project_id = this.remapped('agent_projects', rest.project_id);
        this.insert('agent_project_files', fcols, rest);
        frep.inserted++;
      }
    }
  }

  private mergeMessages(): void {
    if (!this.has('messages')) return;
    const rep = this.table('messages');
    const liveCols = this.liveColumnsStrict('messages');
    const convMap = this.map('conversations');
    for (const row of this.rows('messages')) {
      const newConv = convMap.get(Number(row.conversation_id));
      if (newConv === undefined) { rep.skipped++; continue; }   // conversation not selected
      const { id: oldId, ...rest } = row;
      rest.conversation_id = newConv;
      // Parents sort before children (ids are insertion-ordered), so the map
      // already holds the parent by the time a child arrives.
      if ('parent_message_id' in rest) rest.parent_message_id = this.remapped('messages', rest.parent_message_id);
      this.map('messages').set(Number(oldId), this.insert('messages', liveCols, rest));
      rep.inserted++;
    }
  }

  private mergeAttachments(): void {
    if (!this.has('message_attachments')) return;
    const rep = this.table('message_attachments');
    const liveCols = this.liveColumnsStrict('message_attachments');
    for (const row of this.rows('message_attachments')) {
      const newMsg = this.map('messages').get(Number(row.message_id));
      const newConv = this.map('conversations').get(Number(row.conversation_id));
      if (newMsg === undefined || newConv === undefined) { rep.skipped++; continue; }
      const { id: _id, ...rest } = row;
      rest.message_id = newMsg;
      rest.conversation_id = newConv;
      this.insert('message_attachments', liveCols, rest);
      rep.inserted++;
    }
  }

  /** Remaining tables (skills, prompts, plugin data …): merged verbatim ONLY
   *  into a live table that exists and is empty; otherwise reported. */
  mergeAuxTables(): void {
    const handled = new Set([
      'agent_definitions', 'agent_workspaces', 'memories', 'raw_records',
      'conversations', 'messages', 'message_attachments',
      'agent_projects', 'agent_project_files',
    ]);
    for (const [table, raw] of Object.entries(this.file.tables)) {
      if (handled.has(table) || NEVER_MERGE.has(table)) continue;
      if (!/^[A-Za-z_]\w*$/.test(table)) continue;   // uploaded name, not an identifier
      if (!Array.isArray(raw) || raw.length === 0) continue;
      if (!tableExists(this.live, table)) {
        this.report.skippedTables.push(table);
        this.report.notes.push(`${table}: not in this schema (uninstalled plugin?) — ${raw.length} rows not merged`);
        continue;
      }
      const liveCount = (this.live.prepare(`SELECT count(*) c FROM "${table}"`).get() as { c: number }).c;
      if (liveCount > 0) {
        this.report.skippedTables.push(table);
        this.report.notes.push(`${table}: live table already has ${liveCount} rows — not merged to avoid id collisions`);
        continue;
      }
      const rep = this.table(table);
      const liveCols = this.liveColumnsStrict(table);
      for (const row of this.rows(table)) {
        this.insert(table, liveCols, row);
        rep.inserted++;
      }
    }
  }
}

/**
 * Merge a current-format export into the live database. All writes happen in
 * one transaction; `dryRun` rolls it back after building the report, so the
 * report is exact, not a simulation.
 */
export function mergeExportIntoDb(file: ExportFile, live: Db, opts: MergeOptions = {}): MergeReport {
  if (file.format !== EXPORT_FORMAT) {
    throw new Error(`unrecognised export format '${String(file.format)}' (expected ${EXPORT_FORMAT})`);
  }
  if (!file.tables || typeof file.tables !== 'object') throw new Error('export has no tables');
  const m = new Merger(file, live, opts);
  m.report.dryRun = opts.dryRun === true;
  live.exec('BEGIN');
  try {
    live.exec('PRAGMA defer_foreign_keys = ON');
    m.mergeDefinitions();
    m.mergeWorkspaces();
    m.mergeMemories();
    m.mergeConversations();
    m.mergeAuxTables();
    const violations = live.prepare('PRAGMA foreign_key_check').all() as Array<{ table: string }>;
    if (violations.length) {
      const tables = [...new Set(violations.map(v => v.table))].join(', ');
      throw new Error(`merge left ${violations.length} dangling foreign-key reference(s) in: ${tables}`);
    }
    live.exec(opts.dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (err) {
    live.exec('ROLLBACK');
    throw err;
  }
  return m.report;
}
