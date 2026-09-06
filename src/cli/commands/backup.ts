/**
 * `ritsu backup` — create / list / export / prune / restore database snapshots.
 * The whole system is one SQLite file, so a snapshot is a consistent
 * `VACUUM INTO`. Restore is the break-glass path: it swaps the live DB file,
 * so the service must be stopped first (it can't hot-swap an open DB).
 */
import { writeFileSync, copyFileSync, existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command, CommandContext } from '../registry.js';
import { loadConfig } from '../../config.js';
import { openDatabase } from '../../db.js';
import { BackupManager, importJson, integrityError, type ExportFile } from '../../backup.js';
import { mergeExportIntoLive, type MergeOptions } from '../../merge-import.js';

const SQLITE_MAGIC = 'SQLite format 3\0';

const backupDir = (): string | undefined => process.env.RITSU_BACKUP_DIR?.trim() || undefined;

/** Opens the live database — and so runs the migrations. Only for the
 *  subcommands that genuinely need to read it (create, export). */
function manager(): BackupManager {
  const cfg = loadConfig();
  return new BackupManager(openDatabase(cfg.dbPath), cfg.dbPath, backupDir());
}

/** Filesystem-only view for list / prune. Touches no database. */
function fsManager(): BackupManager {
  return new BackupManager(null, loadConfig().dbPath, backupDir());
}

function looksLikeSqlite(file: string): boolean {
  try { return readFileSync(file, { encoding: 'latin1' }).startsWith(SQLITE_MAGIC); }
  catch { return false; }
}

function runCreate(): number {
  const info = manager().createBackup();
  process.stdout.write(`created ${info.name} (${(info.size / 1024).toFixed(0)} KB)\n`);
  return 0;
}

function runList(): number {
  const rows = fsManager().listBackups();
  if (!rows.length) { process.stdout.write('(no backups yet)\n'); return 0; }
  for (const r of rows) {
    process.stdout.write(`${new Date(r.created_at * 1000).toISOString()}  ${(r.size / 1024).toFixed(0).padStart(7)} KB  ${r.name}\n`);
  }
  return 0;
}

function runExport(ctx: CommandContext): number {
  const out = ctx.positional[0];
  if (!out) { process.stderr.write('usage: ritsu backup export <file>\n'); return 2; }
  writeFileSync(resolve(out), JSON.stringify(manager().exportJson(), null, 2));
  process.stdout.write(`exported to ${resolve(out)}\n`);
  return 0;
}

function runImport(ctx: CommandContext): number {
  const [src, dest] = ctx.positional;
  if (!src || !dest) {
    process.stderr.write('usage: ritsu backup import <export.json> <new.db>\n');
    return 2;
  }
  const file = resolve(src);
  if (!existsSync(file)) { process.stderr.write(`no such file: ${file}\n`); return 1; }
  let parsed: ExportFile;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')) as ExportFile; }
  catch (e) { process.stderr.write(`not valid JSON: ${(e as Error).message}\n`); return 1; }
  try {
    const { counts, skipped } = importJson(parsed, resolve(dest), {
      allowSkip: ctx.flags['skip-unknown'] !== undefined,
    });
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    for (const [t, n] of Object.entries(counts)) process.stdout.write(`  ${t}: ${n}\n`);
    for (const t of skipped) {
      process.stderr.write(`  ! SKIPPED ${t} — table not in this database (rows NOT imported)\n`);
    }
    process.stdout.write(
      `imported ${total} rows into ${resolve(dest)}\n` +
      'NOTE: credentials, tokens and the audit log are not in an export — this is a\n' +
      'portability copy, not a restore. For a full restore use: ritsu backup restore <file.db>\n',
    );
    return 0;
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 1;
  }
}

function runPrune(ctx: CommandContext): number {
  const keep = Number(ctx.flags.keep ?? 14) || 14;
  const removed = fsManager().prune(keep);
  process.stdout.write(`pruned ${removed} (kept newest ${keep})\n`);
  return 0;
}

function runRestore(ctx: CommandContext): number {
  const src = ctx.positional[0];
  if (!src) { process.stderr.write('usage: ritsu backup restore <file>\n'); return 2; }
  const file = resolve(src);
  if (!existsSync(file)) { process.stderr.write(`no such file: ${file}\n`); return 1; }
  if (!looksLikeSqlite(file)) { process.stderr.write(`not a SQLite database: ${file}\n`); return 1; }
  const cfg = loadConfig();
  // Safety net: snapshot the CURRENT db before overwriting it. This one
  // opens the live database, so it must happen BEFORE the sidecars are
  // cleared — and its connection is why they exist at all.
  try { manager().createBackup(); } catch { /* current db may be absent on a fresh box */ }

  copyFileSync(file, cfg.dbPath);
  // The database runs in WAL mode, so the old -wal and -shm sit beside
  // the file we just replaced. SQLite would replay that stale log onto
  // the restored database on next open: at best the restore silently
  // does nothing, at worst the result fails integrity_check outright.
  // The snapshot is self-contained, so the sidecars have nothing to add.
  for (const sidecar of [`${cfg.dbPath}-wal`, `${cfg.dbPath}-shm`]) {
    try { if (existsSync(sidecar)) unlinkSync(sidecar); }
    catch (e) {
      process.stderr.write(`could not remove ${sidecar}: ${(e as Error).message}\n`);
      process.stderr.write('the restored database may be overwritten by a stale write-ahead log\n');
      return 1;
    }
  }

  // Verify rather than assume: a restore that reports success and hands
  // back a corrupt database is worse than one that fails loudly, because
  // this is the path taken when things have already gone wrong.
  const bad = integrityError(cfg.dbPath);
  if (bad) {
    process.stderr.write(`restored file failed integrity check: ${bad}\n`);
    process.stderr.write('the previous database was snapshotted first; see: ritsu backup list\n');
    return 1;
  }

  process.stdout.write(
    `restored ${file} -> ${cfg.dbPath} (${(statSync(cfg.dbPath).size / 1024).toFixed(0)} KB, integrity ok)\n` +
    'restart the service to load it:  sudo ritsu service restart\n' +
    'NOTE: if the service was running during restore, restart is required for a clean load.\n',
  );
  return 0;
}


const ONLY_KINDS = new Set(['definitions', 'memories', 'conversations', 'workspaces']);
const ONLY_ALIAS: Record<string, MergeOptions['only'] extends Array<infer T> | undefined ? T : never> = {
  defs: 'definitions', definitions: 'definitions',
  memories: 'memories', memory: 'memories',
  conversations: 'conversations', chats: 'conversations',
  workspaces: 'workspaces',
};

function csv(v: string | boolean | undefined): string[] {
  return typeof v === 'string' ? v.split(',').map(x => x.trim()).filter(Boolean) : [];
}

function runMerge(ctx: CommandContext): number {
  const src = ctx.positional[0];
  if (!src) { process.stderr.write('usage: ritsu backup merge <export.json> [--dry-run] [--agents a,b] [--only kinds] [--replace-agents a,b]\n'); return 2; }
  const file = resolve(src);
  if (!existsSync(file)) { process.stderr.write(`no such file: ${file}\n`); return 1; }
  let parsed: ExportFile;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')) as ExportFile; }
  catch (e) { process.stderr.write(`not valid JSON: ${(e as Error).message}\n`); return 1; }
  const only: NonNullable<MergeOptions['only']> = [];
  for (const k of csv(ctx.flags.only)) {
    const mapped = ONLY_ALIAS[k];
    if (!mapped || !ONLY_KINDS.has(mapped)) { process.stderr.write(`unknown --only kind '${k}'\n`); return 2; }
    only.push(mapped);
  }
  const opts: MergeOptions = {
    agents: csv(ctx.flags.agents),
    replaceAgents: csv(ctx.flags['replace-agents']),
    dryRun: ctx.flags['dry-run'] !== undefined,
    ...(only.length ? { only } : {}),
  };
  const cfg = loadConfig();
  const scratch = `${cfg.dbPath}.merge-stage`;
  try {
    const report = mergeExportIntoLive(parsed, cfg.dbPath, scratch, opts);
    const head = report.dryRun ? 'DRY RUN — nothing was written. Would merge:' : 'merged:';
    process.stdout.write(`${head}\n`);
    for (const [t, r] of Object.entries(report.tables)) {
      const drops = r.droppedColumns.length ? `  (dropped columns: ${r.droppedColumns.join(', ')})` : '';
      process.stdout.write(`  ${t}: ${r.inserted} in, ${r.skipped} skipped${drops}\n`);
    }
    for (const a of report.skippedAgents) process.stdout.write(`  ! agent '${a}' exists here — definition kept (use --replace-agents ${a} to overwrite)\n`);
    for (const n of report.notes) process.stdout.write(`  ! ${n}\n`);
    if (!report.dryRun) process.stdout.write('restart the service to load the merged data:  sudo systemctl restart ritsu\n');
    return 0;
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 1;
  }
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
    '  ritsu backup import <file> <db>  rebuild a NEW database from a JSON export',
    '                                   (--skip-unknown drops tables this schema',
    '                                   lacks, e.g. from uninstalled plugins;',
    '                                   without it such data is a hard error)',
    '  ritsu backup merge <file>        merge a JSON export INTO the live database',
    '                                   (schema-upgrades old exports; remaps ids;',
    '                                   never touches tokens/keys/channels/settings)',
    '                                   --dry-run          report only, write nothing',
    '                                   --agents a,b       only these agents (default all)',
    '                                   --only defs,memories,conversations,workspaces',
    '                                   --replace-agents a,b  overwrite these live definitions',
    '                                   STOP the service first; restart after.',
    '  ritsu backup prune [--keep N]    keep the newest N snapshots (default 14)',
    '  ritsu backup restore <file>      replace the live DB with a snapshot',
    '                                   (STOP the service first: sudo ritsu service ... )',
  ].join('\n'),
  run: async (ctx: CommandContext): Promise<number> => {
    switch (ctx.subcommand) {
      case null:
      case 'create': return runCreate();
      case 'list': return runList();
      case 'export': return runExport(ctx);
      case 'import': return runImport(ctx);
      case 'merge': return runMerge(ctx);
      case 'prune': return runPrune(ctx);
      case 'restore': return runRestore(ctx);
      default:
        process.stderr.write(`unknown subcommand '${ctx.subcommand}'\n`);
        return 2;
    }
  },
};
