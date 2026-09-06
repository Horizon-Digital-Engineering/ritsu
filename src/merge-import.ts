/**
 * Selective, schema-upgrading import of a JSON export into a LIVE database.
 *
 * The pipeline is stage → migrate → merge:
 *
 *   1. STAGE: rebuild the export as bare tables in a scratch SQLite file,
 *      columns taken from the JSON itself — whatever era wrote it.
 *   2. MIGRATE: open the scratch file through the normal `openDatabase`
 *      path (plus the memory backend), so the SAME migrations that upgrade
 *      a live install upgrade the staged data: dispatcher → runtime/provider,
 *      legacy memory columns → thread_id, added columns, the message-tree
 *      backfill. No rename knowledge is duplicated here — ever.
 *   3. MERGE: copy the now-current-shaped rows into the live database with
 *      integer ids remapped (so nothing collides), FKs re-pointed through
 *      the maps, and a per-table report of what landed, what was skipped,
 *      and which columns were dropped.
 *
 * Credentials NEVER merge: tokens, API keys, audit rows, channel configs
 * (encrypted under the old install's master key and bound to row ids — they
 * could not decrypt here even if we copied them). The live side keeps its own.
 */
import { DatabaseSync } from 'node:sqlite';
import { unlinkSync, existsSync } from 'node:fs';
import { openDatabase, type Db } from './db.js';
import { SqliteMemoryBackend } from './memory/sqlite-backend.js';
import type { ExportFile } from './backup.js';
import { logger } from './util/log.js';

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
  /** Restrict to data kinds. Omitted = all kinds. */
  only?: Array<'definitions' | 'memories' | 'conversations' | 'workspaces'>;
  /** Agent ids whose LIVE definition should be overwritten by the export's. */
  replaceAgents?: string[];
  /** Report only — every write happens in a transaction that rolls back. */
  dryRun?: boolean;
}

export interface TableReport {
  inserted: number;
  skipped: number;
  droppedColumns: string[];
}

export interface MergeReport {
  tables: Record<string, TableReport>;
  skippedTables: string[];
  skippedAgents: string[];
  notes: string[];
  dryRun: boolean;
}

function decodeBlob(v: unknown): unknown {
  if (v && typeof v === 'object' && '$blob' in v) {
    return new Uint8Array(Buffer.from(String((v as { $blob: string }).$blob), 'base64'));
  }
  return v === undefined ? null : v;
}

const IDENT_RE = /^[A-Za-z_]\w*$/;

/** STAGE: write the export's rows into bare, constraint-free tables. */
export function stageExport(file: ExportFile, scratchPath: string): void {
  if (existsSync(scratchPath)) throw new Error(`refusing to overwrite ${scratchPath}`);
  const db = new DatabaseSync(scratchPath);
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    for (const [table, rows] of Object.entries(file.tables)) {
      if (!Array.isArray(rows) || rows.length === 0) continue;
      if (!IDENT_RE.test(table)) { logger.warn('merge.stage.bad-table-name', { table }); continue; }
      const cols = Object.keys(rows[0] as Record<string, unknown>);
      if (!cols.length || !cols.every(c => IDENT_RE.test(c))) {
        logger.warn('merge.stage.bad-columns', { table });
        continue;
      }
      const colList = cols.map(c => `"${c}"`).join(', ');
      db.exec(`CREATE TABLE "${table}" (${colList})`);
      const stmt = db.prepare(`INSERT INTO "${table}" (${colList}) VALUES (${cols.map(() => '?').join(', ')})`);
      for (const row of rows) {
        stmt.run(...(cols.map(c => decodeBlob((row as Record<string, unknown>)[c])) as never[]));
      }
    }
  } finally {
    db.close();
  }
}

/** Columns the memory backend's index DDL touches. An ancient staged table
 *  may predate some; pad them (nullable) BEFORE the backend runs, or its
 *  CREATE INDEX statements fail. thread_id and prev_source_ref are excluded —
 *  the backend's own rename/add migrations own those. */
const RAW_RECORD_PAD: ReadonlyArray<readonly [string, string]> = [
  ['project_id', 'TEXT'], ['source_ref', 'TEXT'], ['mode', 'TEXT'],
  ['supersedes', 'TEXT'], ['acl', 'TEXT'], ['ttl', 'INTEGER'], ['payload', 'TEXT'],
];

function padRawRecordColumns(db: Db): void {
  if (!tableExists(db, 'raw_records')) return;
  const cols = new Set(tableColumns(db, 'raw_records'));
  for (const [name, type] of RAW_RECORD_PAD) {
    if (!cols.has(name)) db.exec(`ALTER TABLE raw_records ADD COLUMN "${name}" ${type}`);
  }
}

/** MIGRATE: run the standard live-upgrade path over the staged file. */
export function migrateStaged(scratchPath: string): Db {
  const db = openDatabase(scratchPath);
  padRawRecordColumns(db);
  // Constructed for its side effect: the backend owns raw_records' legacy
  // renames + added columns.
  void new SqliteMemoryBackend(db);
  return db;
}

type Row = Record<string, unknown>;

function tableColumns(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(c => c.name);
}

function tableExists(db: Db, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table) !== undefined;
}

function rowsOf(db: Db, table: string, orderBy?: string): Row[] {
  const order = orderBy ? ` ORDER BY "${orderBy}"` : '';
  return db.prepare(`SELECT * FROM "${table}"${order}`).all() as Row[];
}

/** Insert `row` into `table` keeping only live columns minus `drop`; returns
 *  the new rowid. Missing live columns take their schema defaults. */
function insertRow(live: Db, table: string, liveCols: Set<string>, row: Row, drop: Set<string>): number {
  const cols = Object.keys(row).filter(c => liveCols.has(c) && !drop.has(c));
  const colList = cols.map(c => '"' + c + '"').join(', ');
  const holes = cols.map(() => '?').join(', ');
  const stmt = live.prepare(`INSERT INTO "${table}" (${colList}) VALUES (${holes})`);
  const r = stmt.run(...(cols.map(c => row[c]) as never[]));
  return Number(r.lastInsertRowid);
}

class Merger {
  readonly report: MergeReport = { tables: {}, skippedTables: [], skippedAgents: [], notes: [], dryRun: false };
  /** old integer id → new integer id, per remapped table. */
  readonly idMaps = new Map<string, Map<number, number>>();
  private readonly selected: Set<string> | null;
  private readonly kinds: Set<string> | null;

  constructor(
    private readonly staged: Db,
    private readonly live: Db,
    private readonly opts: MergeOptions,
  ) {
    this.selected = opts.agents?.length ? new Set(opts.agents) : null;
    this.kinds = opts.only?.length ? new Set(opts.only) : null;
  }

  private wants(kind: string): boolean { return !this.kinds || this.kinds.has(kind); }
  private wantsAgent(id: unknown): boolean { return !this.selected || this.selected.has(String(id)); }

  private table(table: string): TableReport {
    this.report.tables[table] ??= { inserted: 0, skipped: 0, droppedColumns: [] };
    return this.report.tables[table];
  }

  /** Columns present in the staged table but absent live — reported loudly,
   *  then dropped (they are old-schema leftovers the migrations retired). */
  private droppedFor(table: string): Set<string> {
    if (!tableExists(this.live, table)) return new Set();
    const liveCols = new Set(tableColumns(this.live, table));
    const dropped = tableColumns(this.staged, table).filter(c => !liveCols.has(c));
    if (dropped.length) this.table(table).droppedColumns = dropped;
    return new Set(dropped);
  }

  map(table: string): Map<number, number> {
    let m = this.idMaps.get(table);
    if (!m) { m = new Map(); this.idMaps.set(table, m); }
    return m;
  }

  remapped(table: string, v: unknown): unknown {
    if (v === null || v === undefined) return v;
    return this.map(table).get(Number(v)) ?? v;
  }

  mergeDefinitions(): void {
    if (!this.wants('definitions') || !tableExists(this.staged, 'agent_definitions')) return;
    const rep = this.table('agent_definitions');
    const liveCols = new Set(tableColumns(this.live, 'agent_definitions'));
    const drop = this.droppedFor('agent_definitions');
    const replace = new Set(this.opts.replaceAgents ?? []);
    for (const row of rowsOf(this.staged, 'agent_definitions')) {
      const id = row.id as string;
      if (!this.wantsAgent(id)) continue;
      const exists = this.live.prepare('SELECT 1 FROM agent_definitions WHERE id = ?').get(id) !== undefined;
      if (exists && !replace.has(id)) {
        rep.skipped++;
        this.report.skippedAgents.push(id);
        continue;
      }
      if (exists) this.live.prepare('DELETE FROM agent_definitions WHERE id = ?').run(id);
      insertRow(this.live, 'agent_definitions', liveCols, row, drop);
      rep.inserted++;
    }
  }

  mergeWorkspaces(): void {
    if (!this.wants('workspaces') || !tableExists(this.staged, 'agent_workspaces')) return;
    const rep = this.table('agent_workspaces');
    const liveCols = new Set(tableColumns(this.live, 'agent_workspaces'));
    const drop = this.droppedFor('agent_workspaces');
    for (const row of rowsOf(this.staged, 'agent_workspaces')) {
      if (!this.wantsAgent(row.agent_id)) continue;
      const dupe = this.live.prepare('SELECT 1 FROM agent_workspaces WHERE agent_id = ? AND path = ?')
        .get(row.agent_id as string, row.path as string) !== undefined;
      if (dupe) { rep.skipped++; continue; }
      const { id: _id, ...rest } = row;
      insertRow(this.live, 'agent_workspaces', liveCols, rest, drop);
      rep.inserted++;
    }
  }

  mergeMemories(): void {
    if (!this.wants('memories')) return;
    if (tableExists(this.staged, 'memories')) {
      const rep = this.table('memories');
      const liveCols = new Set(tableColumns(this.live, 'memories'));
      const drop = this.droppedFor('memories');
      const rows = rowsOf(this.staged, 'memories', 'id').filter(r => this.wantsAgent(r.agent_id));
      // Two passes: insert with lineage/supersession still pointing at OLD
      // ids, then re-point through the map once every new id exists.
      for (const row of rows) {
        const { id: oldId, ...rest } = row;
        const newId = insertRow(this.live, 'memories', liveCols, rest, drop);
        this.map('memories').set(Number(oldId), newId);
        rep.inserted++;
      }
      const fix = this.live.prepare('UPDATE memories SET superseded_by = ?, lineage_root_id = ? WHERE id = ?');
      for (const row of rows) {
        const newId = this.map('memories').get(Number(row.id))!;
        fix.run(
          this.remapped('memories', row.superseded_by) as never,
          // lineage_root_id 0 is the "am my own root" sentinel — keep it.
          (Number(row.lineage_root_id) ? this.remapped('memories', row.lineage_root_id) : 0) as never,
          newId,
        );
      }
    }
    this.mergeRawRecords();
  }

  private mergeRawRecords(): void {
    if (!tableExists(this.staged, 'raw_records') || !tableExists(this.live, 'raw_records')) return;
    const rep = this.table('raw_records');
    const liveCols = new Set(tableColumns(this.live, 'raw_records'));
    const drop = this.droppedFor('raw_records');
    for (const row of rowsOf(this.staged, 'raw_records')) {
      // UUID keys are collision-safe across installs; a duplicate means a
      // re-run, so skip rather than error.
      const dupe = this.live.prepare('SELECT 1 FROM raw_records WHERE id = ?').get(row.id as string) !== undefined;
      if (dupe) { rep.skipped++; continue; }
      insertRow(this.live, 'raw_records', liveCols, row, drop);
      rep.inserted++;
    }
  }

  mergeConversations(): void {
    if (!this.wants('conversations') || !tableExists(this.staged, 'conversations')) return;
    this.mergeProjects();
    const rep = this.table('conversations');
    const liveCols = new Set(tableColumns(this.live, 'conversations'));
    const drop = this.droppedFor('conversations');
    for (const row of rowsOf(this.staged, 'conversations', 'id')) {
      if (!this.wantsAgent(row.agent_id)) continue;
      const { id: oldId, ...rest } = row;
      if ('project_id' in rest) rest.project_id = this.remapped('agent_projects', rest.project_id);
      const newId = insertRow(this.live, 'conversations', liveCols, rest, drop);
      this.map('conversations').set(Number(oldId), newId);
      rep.inserted++;
    }
    this.mergeMessages();
    this.mergeAttachments();
  }

  private mergeProjects(): void {
    if (!tableExists(this.staged, 'agent_projects')) return;
    const rep = this.table('agent_projects');
    const liveCols = new Set(tableColumns(this.live, 'agent_projects'));
    const drop = this.droppedFor('agent_projects');
    for (const row of rowsOf(this.staged, 'agent_projects', 'id')) {
      if (!this.wantsAgent(row.agent_id)) continue;
      const { id: oldId, ...rest } = row;
      const newId = insertRow(this.live, 'agent_projects', liveCols, rest, drop);
      this.map('agent_projects').set(Number(oldId), newId);
      rep.inserted++;
    }
    if (tableExists(this.staged, 'agent_project_files') && tableExists(this.live, 'agent_project_files')) {
      const frep = this.table('agent_project_files');
      const fcols = new Set(tableColumns(this.live, 'agent_project_files'));
      const fdrop = this.droppedFor('agent_project_files');
      for (const row of rowsOf(this.staged, 'agent_project_files')) {
        if (!this.wantsAgent(row.agent_id)) continue;
        const { id: _id, ...rest } = row;
        if ('project_id' in rest) rest.project_id = this.remapped('agent_projects', rest.project_id);
        insertRow(this.live, 'agent_project_files', fcols, rest, fdrop);
        frep.inserted++;
      }
    }
  }

  private mergeMessages(): void {
    if (!tableExists(this.staged, 'messages')) return;
    const rep = this.table('messages');
    const liveCols = new Set(tableColumns(this.live, 'messages'));
    const drop = this.droppedFor('messages');
    const convMap = this.map('conversations');
    for (const row of rowsOf(this.staged, 'messages', 'id')) {
      const newConv = convMap.get(Number(row.conversation_id));
      if (newConv === undefined) { rep.skipped++; continue; }   // conversation not selected
      const { id: oldId, ...rest } = row;
      rest.conversation_id = newConv;
      // Parents sort before children (ids are insertion-ordered), so the map
      // already holds the parent by the time a child arrives.
      if ('parent_message_id' in rest) rest.parent_message_id = this.remapped('messages', rest.parent_message_id);
      const newId = insertRow(this.live, 'messages', liveCols, rest, drop);
      this.map('messages').set(Number(oldId), newId);
      rep.inserted++;
    }
  }

  private mergeAttachments(): void {
    if (!tableExists(this.staged, 'message_attachments')) return;
    const rep = this.table('message_attachments');
    const liveCols = new Set(tableColumns(this.live, 'message_attachments'));
    const drop = this.droppedFor('message_attachments');
    for (const row of rowsOf(this.staged, 'message_attachments', 'id')) {
      const newMsg = this.map('messages').get(Number(row.message_id));
      const newConv = this.map('conversations').get(Number(row.conversation_id));
      if (newMsg === undefined || newConv === undefined) { rep.skipped++; continue; }
      const { id: _id, ...rest } = row;
      rest.message_id = newMsg;
      rest.conversation_id = newConv;
      insertRow(this.live, 'message_attachments', liveCols, rest, drop);
      rep.inserted++;
    }
  }

  /** Plugin data and anything else recognizably safe: merged verbatim ONLY
   *  into a live table that exists and is empty; otherwise skipped loudly.
   *  (Cross-install id remapping for arbitrary plugin schemas is BAK-1.) */
  mergeAuxTables(): void {
    const handled = new Set([
      'agent_definitions', 'agent_workspaces', 'memories', 'raw_records',
      'conversations', 'messages', 'message_attachments',
      'agent_projects', 'agent_project_files',
    ]);
    const staged = (this.staged
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>).map(r => r.name);
    for (const table of staged) {
      if (handled.has(table) || NEVER_MERGE.has(table)) continue;
      const count = (this.staged.prepare(`SELECT count(*) c FROM "${table}"`).get() as { c: number }).c;
      if (!count) continue;
      if (!tableExists(this.live, table)) {
        this.report.skippedTables.push(table);
        this.report.notes.push(`${table}: not in the live schema (uninstalled plugin?) — ${count} rows not merged`);
        continue;
      }
      const liveCount = (this.live.prepare(`SELECT count(*) c FROM "${table}"`).get() as { c: number }).c;
      if (liveCount > 0) {
        this.report.skippedTables.push(table);
        this.report.notes.push(`${table}: live table already has ${liveCount} rows — not merged to avoid id collisions`);
        continue;
      }
      const rep = this.table(table);
      const liveCols = new Set(tableColumns(this.live, table));
      const drop = this.droppedFor(table);
      for (const row of rowsOf(this.staged, table)) {
        insertRow(this.live, table, liveCols, row, drop);
        rep.inserted++;
      }
    }
  }
}

/**
 * MERGE a migrated scratch database into the live one. All writes happen in
 * one transaction; `dryRun` rolls it back after building the report, so the
 * report is exact, not a simulation.
 */
export function mergeIntoLive(staged: Db, live: Db, opts: MergeOptions = {}): MergeReport {
  const m = new Merger(staged, live, opts);
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

/** One-call pipeline against an ALREADY-OPEN live connection (the admin
 *  server's own handle — in-process merges need no second writer). The
 *  scratch file is deleted afterwards. */
export function mergeExportIntoDb(file: ExportFile, live: Db, scratchPath: string, opts: MergeOptions = {}): MergeReport {
  stageExport(file, scratchPath);
  const staged = migrateStaged(scratchPath);
  try {
    return mergeIntoLive(staged, live, opts);
  } finally {
    staged.close();
    for (const p of [scratchPath, `${scratchPath}-wal`, `${scratchPath}-shm`]) {
      try { if (existsSync(p)) unlinkSync(p); } catch { /* scratch cleanup is best-effort */ }
    }
  }
}

/** CLI variant: opens the live database by path for the duration. */
export function mergeExportIntoLive(file: ExportFile, livePath: string, scratchPath: string, opts: MergeOptions = {}): MergeReport {
  const live = openDatabase(livePath);
  try {
    return mergeExportIntoDb(file, live, scratchPath, opts);
  } finally {
    live.close();
  }
}
