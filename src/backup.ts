/**
 * Backups + export — the data-safety foundation. The whole system is one
 * SQLite file, so a consistent snapshot is a single `VACUUM INTO` (safe to run
 * while the server is live). Two things:
 *   - backup(): a full-fidelity .db snapshot (everything, restorable) written
 *     to the backups dir; downloadable off the box.
 *   - exportJson() / importJson(): a portable, human-readable dump of your
 *     MEANINGFUL data (agents, memories, conversations, plugin data) — excludes
 *     system secrets and tokens, so it is a portability format, not a restore
 *     format. It round-trips: importJson rebuilds a database from one. The .db
 *     snapshot above is the complete copy, and it is what makes "your data is
 *     never hostage" true — it needs no ritsu to read.
 *
 * Restore is a deliberate, service-stopped operation (see the `ritsu restore`
 * CLI) — you can't hot-swap the file under a running server.
 */
import { statSync, readdirSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, type Db } from './db.js';
import { SqliteMemoryBackend } from './memory/sqlite-backend.js';
import { logger } from './util/log.js';

export interface BackupInfo { name: string; size: number; created_at: number }

/** System tables excluded from the JSON export — credentials/tokens/audit, not
 *  "your data" (and not useful in plaintext). The full .db backup still has
 *  them, so a restore is complete. */
const EXPORT_EXCLUDE = new Set([
  'mcp_tokens', 'mcp_token_usage', 'plugin_secrets', 'api_keys', 'admin_audit',
  'oauth_access_tokens', 'oauth_authorize_requests', 'oauth_authz_codes',
  'oauth_clients', 'oauth_refresh_tokens',
]);

const NAME_RE = /^[A-Za-z0-9._-]+\.db$/;

/** Bumped when the on-disk export shape changes. importJson refuses anything
 *  it does not recognise rather than guessing at a foreign file. */
export const EXPORT_FORMAT = 'ritsu-export-1';
/** Alias so a test can assert the stamp without hardcoding the literal twice. */
export const exportFormatForTests = EXPORT_FORMAT;

export interface ExportFile {
  format: string;
  exported_at: number;
  tables: Record<string, unknown[]>;
}

function backupDirFor(dbPath: string, override?: string): string {
  return override ?? join(dirname(dbPath), 'backups');
}

/** VACUUM INTO a fresh, verified snapshot file in `dir`. Shared by the manager
 *  and by the pre-migration snapshot, which has no manager yet. */
function vacuumInto(db: Pick<Db, 'exec'>, dir: string): BackupInfo {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  // VACUUM INTO refuses to overwrite; disambiguate same-millisecond collisions.
  let name = `ritsu-${stamp}.db`;
  let dest = join(dir, name);
  let collision = 1;
  while (existsSync(dest)) {
    name = `ritsu-${stamp}-${collision}.db`;
    dest = join(dir, name);
    collision++;
  }
  db.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`);
  // A truncated snapshot still counts toward keep-N and would displace a good
  // one, so it is unlinked rather than kept.
  const bad = integrityError(dest);
  if (bad) { unlinkSync(dest); throw new Error(`backup failed integrity check: ${bad}`); }
  const st = statSync(dest);
  logger.info('backup.created', { name, size: st.size });
  return { name, size: st.size, created_at: Math.floor(st.mtimeMs / 1000) };
}

/**
 * Snapshot the database BEFORE the migrations run, on its own connection.
 * The boot snapshot used to be taken after `openDatabase`, so a migration that
 * ate data landed in the newest backup — and on a redeploy-heavy day the last
 * clean copy rolled out of retention. No-op on a fresh install.
 */
export function snapshotPreMigration(dbPath: string, backupDir?: string): void {
  if (!existsSync(dbPath)) return;
  const db = new DatabaseSync(dbPath);
  try { vacuumInto(db, backupDirFor(dbPath, backupDir)); }
  finally { db.close(); }
}

export class BackupManager {
  /** `db` is null for the filesystem-only operations (list, prune, delete).
   *  Those must not open the live database: opening it runs the migrations,
   *  so `ritsu backup list` would rebuild tables on a second connection while
   *  the service is running. */
  constructor(private readonly db: Db | null, private readonly dbPath: string, private readonly backupDir?: string) {}

  private database(): Db {
    if (!this.db) throw new Error('this operation needs an open database');
    return this.db;
  }

  dir(): string {
    return backupDirFor(this.dbPath, this.backupDir);
  }

  /** Consistent snapshot of the whole DB into the backups dir. */
  createBackup(): BackupInfo {
    return vacuumInto(this.database(), this.dir());
  }

  listBackups(): BackupInfo[] {
    const d = this.dir();
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter(f => f.endsWith('.db'))
      .map(name => {
        const st = statSync(join(d, name));
        // Sort key is sub-second: two snapshots in the same second (a redeploy
        // loop) would otherwise order arbitrarily and prune the wrong one.
        return { name, size: st.size, created_at: Math.floor(st.mtimeMs / 1000), mtimeMs: st.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map(({ mtimeMs: _mtimeMs, ...info }) => info);
  }

  /** Absolute path of a backup for download — validated against traversal. */
  pathFor(name: string): string | null {
    if (!NAME_RE.test(name)) return null;
    const p = join(this.dir(), name);
    return existsSync(p) ? p : null;
  }

  deleteBackup(name: string): boolean {
    const p = this.pathFor(name);
    if (!p) return false;
    unlinkSync(p);
    logger.info('backup.deleted', { name });
    return true;
  }

  /** Keep the newest `keep` backups, delete the rest. Returns count removed.
   *  keep is floored at 1: a stored 0 (or a negative) would otherwise delete
   *  every snapshot, including the one taken milliseconds earlier. */
  prune(keep: number): number {
    const all = this.listBackups();
    const stale = all.slice(Math.max(1, Math.floor(keep)));
    for (const b of stale) this.deleteBackup(b.name);
    if (stale.length) logger.info('backup.pruned', { removed: stale.length, kept: keep });
    return stale.length;
  }

  /** Portable JSON of the meaningful data (no secrets/tokens). */
  exportJson(): ExportFile {
    const db = this.database();
    const names = (db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>).map(r => r.name);
    const tables: Record<string, unknown[]> = {};
    for (const name of names) {
      if (EXPORT_EXCLUDE.has(name)) continue;
      tables[name] = db.prepare(`SELECT * FROM "${name}"`).all().map(encodeBlobs);
    }
    return { format: EXPORT_FORMAT, exported_at: Math.floor(Date.now() / 1000), tables };
  }
}

/**
 * Rebuild a database from an `exportJson()` file. Writes a NEW file and refuses
 * to touch an existing one: the export deliberately omits credentials and audit
 * rows, so importing over a live database would produce a half-populated system
 * that looks whole. The `.db` snapshot is the restore path; this is the
 * portability path, and it exists so the JSON format is genuinely round-trippable
 * rather than write-only.
 *
 * Returns the per-table row counts actually inserted plus the tables that were
 * NOT imported. A non-empty table the current schema doesn't have is fatal by
 * default — silently dropping data is how a migration loses 180 memory records
 * without an error — and only `allowSkip` downgrades that to a reported skip.
 */
export function importJson(
  file: ExportFile,
  destPath: string,
  opts: { allowSkip?: boolean } = {},
): { counts: Record<string, number>; skipped: string[] } {
  // Exports from before the format field existed ARE the version-1 shape —
  // the stamp was added without changing the layout. Anything else is refused.
  const format = file.format ?? EXPORT_FORMAT;
  if (format !== EXPORT_FORMAT) {
    throw new Error(`unrecognised export format '${String(file.format)}' (expected ${EXPORT_FORMAT})`);
  }
  if (existsSync(destPath)) throw new Error(`refusing to overwrite ${destPath}`);
  const db = openDatabase(destPath);
  try {
    // Tables created lazily at boot (not by openDatabase's migrations) must
    // exist BEFORE the copy, or their rows vanish as "unknown". The memory
    // backend's raw_records is the big one. Plugin tables need their plugin's
    // own migration and stay unknown here — reported below, never dropped
    // silently.
    new SqliteMemoryBackend(db);

    const known = new Set((db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>).map(r => r.name));
    const skipped = Object.entries(file.tables)
      .filter(([t, rows]) => !known.has(t) && Array.isArray(rows) && rows.length > 0)
      .map(([t]) => t);
    if (skipped.length && !opts.allowSkip) {
      throw new Error(
        `export contains data for tables this database does not have: ${skipped.join(', ')}. ` +
        'These are usually plugin tables — install the plugins and re-import, or pass ' +
        '--skip-unknown to import everything else and drop these.',
      );
    }
    const counts: Record<string, number> = {};
    db.transaction(() => {
      // Rows arrive in export-table order (alphabetical), which violates FK
      // order (message_attachments before messages) and can never satisfy
      // self-referential FKs (a conversation whose parent sorts later). Defer
      // enforcement to commit and verify the finished graph explicitly.
      db.exec('PRAGMA defer_foreign_keys = ON');
      for (const [table, rows] of Object.entries(file.tables)) {
        if (!known.has(table) || !Array.isArray(rows) || rows.length === 0) continue;
        const cols = Object.keys(rows[0] as Record<string, unknown>);
        const colList = cols.map(c => '"' + c + '"').join(', ');
        const holes = cols.map(() => '?').join(', ');
        const stmt = db.prepare(`INSERT OR REPLACE INTO "${table}" (${colList}) VALUES (${holes})`);
        for (const row of rows) stmt.run(...cols.map(c => decodeBlob((row as Record<string, unknown>)[c])));
        counts[table] = rows.length;
      }
      const violations = db.prepare('PRAGMA foreign_key_check').all() as Array<{ table: string }>;
      if (violations.length) {
        const tables = [...new Set(violations.map(v => v.table))].join(', ');
        throw new Error(`import left ${violations.length} dangling foreign-key reference(s) in: ${tables}`);
      }
    })();
    return { counts, skipped };
  } finally {
    db.close();
  }
}

/** Inverse of encodeBlobs. */
function decodeBlob(v: unknown): unknown {
  if (v && typeof v === 'object' && '$blob' in v) {
    return new Uint8Array(Buffer.from(String(v.$blob), 'base64'));
  }
  return v === undefined ? null : v;
}

/** SQLite BLOBs come back as Uint8Array, and JSON.stringify renders those as
 *  {"0":222,"1":173,...} — not base64, not restorable by anything. Tag them
 *  instead, so the export round-trips. */
function encodeBlobs(row: unknown): unknown {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    out[k] = v instanceof Uint8Array
      ? { $blob: Buffer.from(v).toString('base64') }
      : v;
  }
  return out;
}

/** `PRAGMA integrity_check` on a file, without migrating it. Returns the
 *  failure text, or null when the file is a sound SQLite database. */
export function integrityError(path: string): string | null {
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
      const result = row?.integrity_check ?? 'no result';
      return result === 'ok' ? null : result;
    } finally { db.close(); }
  } catch (err) {
    return (err as Error).message;
  }
}
