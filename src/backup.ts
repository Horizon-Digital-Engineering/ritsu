/**
 * Backups + export — the data-safety foundation. The whole system is one
 * SQLite file, so a consistent snapshot is a single `VACUUM INTO` (safe to run
 * while the server is live). Two things:
 *   - backup(): a full-fidelity .db snapshot (everything, restorable) written
 *     to the backups dir; downloadable off the box.
 *   - exportJson(): a portable, human-readable dump of your MEANINGFUL data
 *     (agents, memories, conversations, plugin data) — excludes system secrets
 *     and tokens. This is the "your data is never hostage" escape hatch.
 *
 * Restore is a deliberate, service-stopped operation (see the `ritsu restore`
 * CLI) — you can't hot-swap the file under a running server.
 */
import { statSync, readdirSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Db } from './db.js';
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

export class BackupManager {
  constructor(private readonly db: Db, private readonly dbPath: string, private readonly backupDir?: string) {}

  dir(): string {
    return this.backupDir ?? join(dirname(this.dbPath), 'backups');
  }

  private ensureDir(): string {
    const d = this.dir();
    mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  }

  /** Consistent snapshot of the whole DB into the backups dir. */
  createBackup(): BackupInfo {
    const d = this.ensureDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // VACUUM INTO refuses to overwrite; disambiguate same-millisecond collisions.
    let name = `ritsu-${stamp}.db`;
    let dest = join(d, name);
    for (let n = 1; existsSync(dest); n++) { name = `ritsu-${stamp}-${n}.db`; dest = join(d, name); }
    this.db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    const st = statSync(dest);
    logger.info('backup.created', { name, size: st.size });
    return { name, size: st.size, created_at: Math.floor(st.mtimeMs / 1000) };
  }

  listBackups(): BackupInfo[] {
    const d = this.dir();
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter(f => f.endsWith('.db'))
      .map(name => {
        const st = statSync(join(d, name));
        return { name, size: st.size, created_at: Math.floor(st.mtimeMs / 1000) };
      })
      .sort((a, b) => b.created_at - a.created_at);
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

  /** Keep the newest `keep` backups, delete the rest. Returns count removed. */
  prune(keep: number): number {
    const all = this.listBackups();
    const stale = all.slice(Math.max(0, keep));
    for (const b of stale) this.deleteBackup(b.name);
    if (stale.length) logger.info('backup.pruned', { removed: stale.length, kept: keep });
    return stale.length;
  }

  /** Portable JSON of the meaningful data (no secrets/tokens). */
  exportJson(): { exported_at: number; tables: Record<string, unknown[]> } {
    const names = (this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>).map(r => r.name);
    const tables: Record<string, unknown[]> = {};
    for (const name of names) {
      if (EXPORT_EXCLUDE.has(name)) continue;
      tables[name] = this.db.prepare(`SELECT * FROM "${name}"`).all();
    }
    return { exported_at: Math.floor(Date.now() / 1000), tables };
  }
}
