/**
 * `ritsu backup` — snapshot / list / export / prune / restore the database.
 * The whole system is one SQLite file, so a snapshot is a consistent
 * `VACUUM INTO`. Restore is the break-glass path: it swaps the live DB file,
 * so the service must be stopped first (it can't hot-swap an open DB).
 */
import { writeFileSync, copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command, CommandContext } from '../registry.js';
import { loadConfig } from '../../config.js';
import { openDatabase } from '../../db.js';
import { BackupManager } from '../../backup.js';

const SQLITE_MAGIC = 'SQLite format 3\0';

function manager(): BackupManager {
  const cfg = loadConfig();
  const db = openDatabase(cfg.dbPath);
  return new BackupManager(db, cfg.dbPath, process.env.RITSU_BACKUP_DIR?.trim() || undefined);
}

function looksLikeSqlite(file: string): boolean {
  try { return readFileSync(file, { encoding: 'latin1' }).slice(0, 16) === SQLITE_MAGIC; }
  catch { return false; }
}

export const backupCommand: Command = {
  name: 'backup',
  summary: 'snapshot / list / export / prune / restore the database',
  needsRoot: true,
  help: () => [
    'ritsu backup — database backups + export',
    '',
    '  ritsu backup                     create a snapshot now',
    '  ritsu backup list                list snapshots',
    '  ritsu backup export <file>       write a JSON export (your data, no secrets)',
    '  ritsu backup prune [--keep N]    keep the newest N snapshots (default 14)',
    '  ritsu backup restore <file>      replace the live DB with a snapshot',
    '                                   (STOP the service first: sudo ritsu service ... )',
  ].join('\n'),
  run: async (ctx: CommandContext): Promise<number> => {
    switch (ctx.subcommand) {
      case null:
      case 'create': {
        const info = manager().createBackup();
        process.stdout.write(`created ${info.name} (${(info.size / 1024).toFixed(0)} KB)\n`);
        return 0;
      }
      case 'list': {
        const rows = manager().listBackups();
        if (!rows.length) { process.stdout.write('(no backups yet)\n'); return 0; }
        for (const r of rows) {
          process.stdout.write(`${new Date(r.created_at * 1000).toISOString()}  ${(r.size / 1024).toFixed(0).padStart(7)} KB  ${r.name}\n`);
        }
        return 0;
      }
      case 'export': {
        const out = ctx.positional[0];
        if (!out) { process.stderr.write('usage: ritsu backup export <file>\n'); return 2; }
        writeFileSync(resolve(out), JSON.stringify(manager().exportJson(), null, 2));
        process.stdout.write(`exported to ${resolve(out)}\n`);
        return 0;
      }
      case 'prune': {
        const keep = Number(ctx.flags.keep ?? 14) || 14;
        const removed = manager().prune(keep);
        process.stdout.write(`pruned ${removed} (kept newest ${keep})\n`);
        return 0;
      }
      case 'restore': {
        const src = ctx.positional[0];
        if (!src) { process.stderr.write('usage: ritsu backup restore <file>\n'); return 2; }
        const file = resolve(src);
        if (!existsSync(file)) { process.stderr.write(`no such file: ${file}\n`); return 1; }
        if (!looksLikeSqlite(file)) { process.stderr.write(`not a SQLite database: ${file}\n`); return 1; }
        const cfg = loadConfig();
        // Safety net: snapshot the CURRENT db before overwriting it.
        try { manager().createBackup(); } catch { /* current db may be absent on a fresh box */ }
        copyFileSync(file, cfg.dbPath);
        process.stdout.write(
          `restored ${file} -> ${cfg.dbPath} (${(statSync(cfg.dbPath).size / 1024).toFixed(0)} KB)\n` +
          'restart the service to load it:  sudo ritsu service restart\n' +
          'NOTE: if the service was running during restore, restart is required for a clean load.\n',
        );
        return 0;
      }
      default:
        process.stderr.write(`unknown subcommand '${ctx.subcommand}'\n`);
        return 2;
    }
  },
};
