/**
 * `ritsu backup` — encrypted snapshots of the database: create / list /
 * set-password / rehearse / restore / prune, plus the JSON export and import.
 * Restore swaps the live file, so the service must be stopped first; the
 * command checks and refuses otherwise.
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Command, CommandContext } from '../registry.js';
import { loadConfig } from '../../config.js';
import { openDatabase } from '../../db.js';
import { discoverPlugins } from '../../plugins/discover.js';
import { spawnSync } from '../../util/safe-spawn.js';
import { SERVICE_NAME } from '../systemd.js';
import { promptSecret } from '../prompt.js';
import {
  BackupManager, backupDirFromEnv, checkPassword, createBackupFrom, dataDirOf, importJson, loadPassword,
  rehearse, restore, savePassword, MIN_PASSWORD_CHARS, PRE_UPGRADE_KEEP, RehearsalError, WrongPassword,
  type ExportFile, type RehearsalReport,
} from '../../backup.js';

const out = (s: string): void => { process.stdout.write(`${s}\n`); };
const err = (s: string): void => { process.stderr.write(`${s}\n`); };

/** Filesystem-only view for list / prune / locate. Touches no database. */
function fsManager(): BackupManager {
  return new BackupManager(null, loadConfig().dbPath, backupDirFromEnv());
}

/** Opens the live database — and so runs the migrations. Only for export. */
function manager(): BackupManager {
  const cfg = loadConfig();
  return new BackupManager(openDatabase(cfg.dbPath), cfg.dbPath, backupDirFromEnv());
}

async function passwordFor(dataDir: string): Promise<string> {
  return loadPassword(dataDir) ?? promptSecret('Backup password: ');
}

/** `latest` (this host's, or --host's), a path, or a file name in the folder. */
function locate(ctx: CommandContext, target: string): string | null {
  const mgr = fsManager();
  const host = typeof ctx.flags.host === 'string' ? ctx.flags.host : mgr.host;
  if (target === 'latest') {
    const b = mgr.latest(host);
    if (!b) { err(`no backups of ${host} in ${mgr.dir()}`); return null; }
    return resolve(mgr.dir(), b.name);
  }
  const asPath = resolve(target);
  if (existsSync(asPath)) return asPath;
  const inFolder = mgr.pathFor(target);
  if (inFolder) return inFolder;
  err(`${target} is neither a file nor a backup in ${mgr.dir()}`);
  return null;
}

function serviceActive(): boolean {
  const r = spawnSync('systemctl', ['is-active', SERVICE_NAME], { encoding: 'utf8' });
  return r.status === 0;
}

const kb = (n: number): string => `${(n / 1024).toFixed(0)} KB`;

async function runCreate(): Promise<number> {
  const cfg = loadConfig();
  const dataDir = dataDirOf(cfg.dbPath);
  const password = loadPassword(dataDir);
  if (!password) { err('no backup password set — run: ritsu backup set-password'); return 1; }
  if (!existsSync(cfg.dbPath)) { err(`no database at ${cfg.dbPath}`); return 1; }
  const mgr = fsManager();
  // Read-only: the service may be running on this file, and a second
  // connection must not run migrations as root.
  const db = new DatabaseSync(cfg.dbPath, { readOnly: true });
  try {
    const info = await createBackupFrom(db, cfg.dbPath, mgr.dir(), mgr.host, 'daily', password);
    out(`created ${info.name} (${kb(info.size)}) in ${mgr.dir()}`);
    return 0;
  } finally { db.close(); }
}

function runList(ctx: CommandContext): number {
  const mgr = fsManager();
  let rows = mgr.listBackups();
  if (typeof ctx.flags.host === 'string') rows = rows.filter(r => r.host === ctx.flags.host);
  if (ctx.flags.json) { out(JSON.stringify({ dir: mgr.dir(), host: mgr.host, backups: rows }, null, 2)); return 0; }
  out(`${mgr.dir()}  (this host: ${mgr.host}, password ${mgr.passwordSet() ? 'set' : 'NOT set'})`);
  if (!rows.length) { out('(no backups yet)'); return 0; }
  for (const r of rows) {
    out(`${new Date(r.created_at * 1000).toISOString()}  ${kb(r.size).padStart(10)}  ${r.kind.padEnd(11)}  ${r.name}`);
  }
  return 0;
}

async function runSetPassword(): Promise<number> {
  const dataDir = dataDirOf(loadConfig().dbPath);
  const p1 = await promptSecret(`New backup password (at least ${MIN_PASSWORD_CHARS} characters): `);
  const bad = checkPassword(p1);
  if (bad) { err(bad); return 1; }
  if (process.stdin.isTTY) {
    const p2 = await promptSecret('Again: ');
    if (p1 !== p2) { err('passwords differ'); return 1; }
  }
  savePassword(dataDir, p1);
  out(`saved to ${dataDir}/backup-password — keep a copy somewhere safe; a backup cannot be opened without it`);
  return 0;
}

function renderRehearsal(r: RehearsalReport): string {
  const lines = [
    `Rehearsed ${r.backup} (schema ${r.schema_changed ? 'changes' : 'unchanged'}, ${(r.duration_ms / 1000).toFixed(1)} s)`,
  ];
  for (const k of r.schema.added) lines.push(`  + ${k}`);
  for (const k of r.schema.removed) lines.push(`  - ${k}`);
  for (const k of r.schema.altered) lines.push(`  ~ ${k}`);
  for (const t of r.tables) {
    if (t.before === null) lines.push(`  + ${t.name} (new, ${t.after} rows)`);
    else if (t.after === null) lines.push(`  - ${t.name} (dropped, had ${t.before} rows)`);
    else if (t.before !== t.after) lines.push(`  ${t.name} ${t.before} → ${t.after}`);
  }
  const same = r.tables.filter(t => t.before !== null && t.after !== null && t.before === t.after).map(t => `${t.name} ${t.before}`);
  if (same.length) lines.push(`  ${same.join(' · ')}`);
  if (r.kept_at) lines.push(`  kept at ${r.kept_at}`);
  lines.push('  ok');
  return lines.join('\n');
}

async function runRehearse(ctx: CommandContext): Promise<number> {
  const file = locate(ctx, ctx.positional[0] ?? 'latest');
  if (!file) return 1;
  const cfg = loadConfig();
  const dataDir = dataDirOf(cfg.dbPath);
  const password = await passwordFor(dataDir);
  try {
    const report = await rehearse(file, password, await discoverPlugins(), dataDir, ctx.flags.keep === true);
    out(ctx.flags.json ? JSON.stringify(report, null, 2) : renderRehearsal(report));
    return 0;
  } catch (e) {
    if (e instanceof WrongPassword || e instanceof RehearsalError) { err(e.message); return 1; }
    throw e;
  }
}

async function runRestore(ctx: CommandContext): Promise<number> {
  const file = locate(ctx, ctx.positional[0] ?? 'latest');
  if (!file) return 1;
  if (serviceActive()) {
    err(`${SERVICE_NAME} is running; stop it first:  sudo systemctl stop ${SERVICE_NAME}`);
    return 1;
  }
  const cfg = loadConfig();
  const password = await passwordFor(dataDirOf(cfg.dbPath));
  try {
    const r = await restore(file, cfg.dbPath, password);
    out(`restored ${r.restored_from} -> ${cfg.dbPath}`);
    out(`  ${r.agents} agents · ${r.conversations} conversations · ${r.memories} memories`);
    if (r.previous_saved_to) out(`  the previous database is in ${r.previous_saved_to}`);
    out(`start the service to load it:  sudo systemctl start ${SERVICE_NAME}`);
    return 0;
  } catch (e) {
    err((e as Error).message);
    return 1;
  }
}

function runPrune(ctx: CommandContext): number {
  const keep = Number(ctx.flags.keep ?? 14) || 14;
  const removed = fsManager().prune(keep);
  out(`pruned ${removed} (kept newest ${keep} daily, ${PRE_UPGRADE_KEEP} pre-upgrade)`);
  return 0;
}

function runExport(ctx: CommandContext): number {
  const target = ctx.positional[0];
  if (!target) { err('usage: ritsu backup export <file>'); return 2; }
  writeFileSync(resolve(target), JSON.stringify(manager().exportJson(), null, 2));
  out(`exported to ${resolve(target)}`);
  return 0;
}

function runImport(ctx: CommandContext): number {
  const [src, dest] = ctx.positional;
  if (!src || !dest) { err('usage: ritsu backup import <export.json> <new.db>'); return 2; }
  const file = resolve(src);
  if (!existsSync(file)) { err(`no such file: ${file}`); return 1; }
  let parsed: ExportFile;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')) as ExportFile; }
  catch (e) { err(`not valid JSON: ${(e as Error).message}`); return 1; }
  try {
    const { counts, skipped } = importJson(parsed, resolve(dest), { allowSkip: ctx.flags['skip-unknown'] !== undefined });
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    for (const [t, n] of Object.entries(counts)) out(`  ${t}: ${n}`);
    for (const t of skipped) err(`  ! SKIPPED ${t} — table not in this database (rows NOT imported)`);
    out(`imported ${total} rows into ${resolve(dest)}`);
    out('NOTE: credentials, tokens and the audit log are not in an export — this is a');
    out('portability copy, not a restore. For a full restore use: ritsu backup restore');
    return 0;
  } catch (e) {
    err((e as Error).message);
    return 1;
  }
}

export const backupCommand: Command = {
  name: 'backup',
  summary: 'encrypted snapshots: create / list / rehearse / restore, plus JSON export',
  needsRoot: true,
  help: () => [
    'ritsu backup — encrypted database backups',
    '',
    '  ritsu backup                          snapshot now, encrypted with the backup password',
    '  ritsu backup list [--host H]          what is in the folder, newest first',
    '  ritsu backup set-password             set the password backups are encrypted with',
    '  ritsu backup rehearse [latest|name|path] [--host H] [--keep]',
    '                                        decrypt a backup into scratch and run this',
    '                                        build\'s migrations on it; report row counts',
    '  ritsu backup restore [latest|name|path] [--host H]',
    '                                        replace the live database (STOP the service first);',
    '                                        the previous one is kept in data/pre-restore-<time>/',
    '  ritsu backup prune [--keep N]         keep the newest N daily snapshots (default 14)',
    '  ritsu backup export <file>            write a JSON export (your data, no secrets)',
    '  ritsu backup import <file> <db>       rebuild a NEW database from a JSON export',
    '                                        (--skip-unknown drops tables this schema lacks)',
    '',
    '  `latest` is this host\'s newest daily backup; --host picks another machine\'s.',
    '  The folder is RITSU_BACKUP_DIR, or backups/ beside the database.',
  ].join('\n'),
  run: async (ctx: CommandContext): Promise<number> => {
    switch (ctx.subcommand) {
      case null:
      case 'create': return runCreate();
      case 'list': return runList(ctx);
      case 'set-password': return runSetPassword();
      case 'rehearse': return runRehearse(ctx);
      case 'restore': return runRestore(ctx);
      case 'prune': return runPrune(ctx);
      case 'export': return runExport(ctx);
      case 'import': return runImport(ctx);
      default:
        err(`unknown subcommand '${ctx.subcommand}'`);
        return 2;
    }
  },
};
