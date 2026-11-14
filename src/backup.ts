/**
 * Backups, restore, rehearsal and export. The whole system is one SQLite
 * file, so a consistent snapshot is a single `VACUUM INTO` (safe while the
 * server is live). A backup is that snapshot encrypted with a password in the
 * age format, so it can sit on a shared drive and still opens anywhere with
 * `age -d`. The password lives in a 0600 file in the data dir and is never in
 * a backup; the master key that unlocks stored secrets is kept out too.
 *
 * One series per host: `ritsu-<host>-<time>.db.age` daily, and
 * `ritsu-<host>-pre-upgrade-<time>.db.age` written by a boot whose migrations
 * change the schema, kept apart from the daily series so a redeploy-heavy day
 * cannot rotate the last good copy away.
 *
 * Restore is a deliberate, service-stopped operation (`ritsu backup restore`):
 * an open database cannot be hot-swapped. The database it replaces is moved
 * aside, never deleted. A rehearsal decrypts a backup into scratch, checks it
 * and runs this build's migrations on the copy, so an upgrade is proven on
 * yesterday's data before the live file is touched.
 *
 * exportJson() / importJson() stay the portability path: a readable dump of
 * the meaningful data without credentials, which round-trips into a new file.
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, chownSync, copyFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { basename, dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Decrypter, Encrypter } from 'age-encryption';
import { openDatabase, type Db } from './db.js';
import { ensureMemorySchema } from './memory/sqlite-backend.js';
import { ensureSettingsSchema } from './settings-store.js';
import { SecretStore } from './auth/secret-store.js';
import { PluginHost } from './plugins/host.js';
import type { Plugin } from './plugins/types.js';
import { logger } from './util/log.js';

export type BackupKind = 'daily' | 'pre-upgrade';

/** A boot that must not go on, with a message for the operator to read as is. */
export class StartupRefused extends Error {
  constructor(message: string) { super(message); this.name = 'StartupRefused'; }
}

export interface BackupInfo { name: string; host: string; kind: BackupKind; created_at: number; size: number }

const PREFIX = 'ritsu-';
const SUFFIX = '.db.age';
const PRE_UPGRADE_MARK = 'pre-upgrade';
const PASSWORD_FILE = 'backup-password';
/** Names the pre-upgrade copy already taken for the schema this build ends at,
 *  so a boot that fails partway through its migrations and is started again
 *  does not back up the half-migrated file over the real one. */
const PRE_UPGRADE_RECORD = 'pre-upgrade.json';
const ASIDE_PREFIX = 'pre-restore-';
export const MIN_PASSWORD_CHARS = 15;
/** Pre-upgrade copies are kept apart from the daily series: the last few per host. */
export const PRE_UPGRADE_KEEP = 5;
/** Databases a restore moved aside, under the data dir. */
export const ASIDE_KEEP = 3;
// Pinned so a backup made on one machine opens on another: 2^18 is about 256 MiB of scrypt memory.
let scryptLogN = 18;
export function _setScryptWorkFactorForTests(logN: number): void { scryptLogN = logN; }

/** Letters, digits and dashes, so a name can never carry a path. */
export function hostName(): string {
  const short = hostname().split('.')[0]?.toLowerCase() ?? '';
  // The first replace collapses runs, so at most one dash can sit at either end.
  const clean = short.replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-|-$/g, '');
  return clean || 'host';
}

/** 20261113T171102Z */
function stamp(at: Date): string {
  return `${at.toISOString().replaceAll(/[-:]/g, '').slice(0, 15)}Z`;
}

function parseStamp(s: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fileName(host: string, kind: BackupKind, at: Date): string {
  const mark = kind === 'pre-upgrade' ? `-${PRE_UPGRADE_MARK}` : '';
  return `${PREFIX}${host}${mark}-${stamp(at)}${SUFFIX}`;
}

export function parseName(name: string): { host: string; kind: BackupKind; at: Date } | null {
  if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) return null;
  const core = name.slice(PREFIX.length, -SUFFIX.length);
  const dash = core.lastIndexOf('-');
  if (dash < 1) return null;
  const at = parseStamp(core.slice(dash + 1));
  if (!at) return null;
  let host = core.slice(0, dash);
  let kind: BackupKind = 'daily';
  if (host.endsWith(`-${PRE_UPGRADE_MARK}`)) { host = host.slice(0, -(PRE_UPGRADE_MARK.length + 1)); kind = 'pre-upgrade'; }
  if (!host || !/^[a-z0-9-]+$/i.test(host)) return null;
  return { host, kind, at };
}

export function dataDirOf(dbPath: string): string { return dirname(dbPath); }

/** `RITSU_BACKUP_DIR` when set, else `backups/` beside the database. */
export function resolveBackupDir(dbPath: string, override?: string): { dir: string; source: 'RITSU_BACKUP_DIR' | 'data dir' } {
  return override ? { dir: override, source: 'RITSU_BACKUP_DIR' } : { dir: join(dataDirOf(dbPath), 'backups'), source: 'data dir' };
}

export function backupDirFromEnv(): string | undefined {
  return process.env.RITSU_BACKUP_DIR?.trim() || undefined;
}

/** Files the CLI writes into the data dir as root take the data dir's owner,
 *  or the service could not read them. A no-op when the owner already matches. */
function matchOwner(path: string, dataDir: string): void {
  try {
    const { uid, gid } = statSync(dataDir);
    chownSync(path, uid, gid);
  } catch { /* not ours to chown; the service user wrote it */ }
}

// ---- password ---------------------------------------------------------------

export function passwordPath(dataDir: string): string { return join(dataDir, PASSWORD_FILE); }

/** The failure text, or null when the password is acceptable. */
export function checkPassword(p: string): string | null {
  return [...p].length < MIN_PASSWORD_CHARS
    ? `backup password must be at least ${MIN_PASSWORD_CHARS} characters; the backups may sit on a shared drive`
    : null;
}

export function savePassword(dataDir: string, password: string): void {
  const bad = checkPassword(password);
  if (bad) throw new Error(bad);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = passwordPath(dataDir);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, password, { mode: 0o600 });
  matchOwner(tmp, dataDir);
  renameSync(tmp, path);
}

export function loadPassword(dataDir: string): string | null {
  try {
    const s = readFileSync(passwordPath(dataDir), 'utf8');
    return s.length ? s : null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

// ---- encryption -----------------------------------------------------------------

export class WrongPassword extends Error {
  constructor() { super('wrong password for this backup'); this.name = 'WrongPassword'; }
}

export async function encryptFile(src: string, dst: string, password: string): Promise<void> {
  const enc = new Encrypter();
  enc.setPassphrase(password);
  enc.setScryptWorkFactor(scryptLogN);
  const out = await enc.encrypt(Readable.toWeb(createReadStream(src)) as ReadableStream<Uint8Array>);
  await pipeline(Readable.fromWeb(out as ReadableStream<Uint8Array>), createWriteStream(dst, { mode: 0o600 }));
}

export async function decryptFile(src: string, dst: string, password: string): Promise<void> {
  const dec = new Decrypter();
  dec.addPassphrase(password);
  let out: ReadableStream<Uint8Array>;
  try {
    // The header is checked before this resolves, so a wrong password fails here.
    out = await dec.decrypt(Readable.toWeb(createReadStream(src)) as ReadableStream<Uint8Array>);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes('no identity matched')) throw new WrongPassword();
    throw new Error(`not a backup file: ${msg}`);
  }
  try {
    await pipeline(Readable.fromWeb(out), createWriteStream(dst, { mode: 0o600 }));
  } catch (e) {
    throw new Error(`backup is damaged or truncated: ${(e as Error).message}`);
  }
}

// ---- the folder ---------------------------------------------------------------

export function listBackups(dir: string): BackupInfo[] {
  if (!existsSync(dir)) return [];
  const out: BackupInfo[] = [];
  for (const name of readdirSync(dir)) {
    const p = parseName(name);
    if (!p) continue;
    let size = 0;
    try { size = statSync(join(dir, name)).size; } catch { /* listed between readdir and stat */ }
    out.push({ name, host: p.host, kind: p.kind, created_at: Math.floor(p.at.getTime() / 1000), size });
  }
  return out.sort((a, b) => b.created_at - a.created_at || b.name.localeCompare(a.name));
}

/** The newest daily backup, one host's when given. A pre-upgrade copy is taken
 *  only when the host has no daily one: it is older than the data by design. */
export function latestBackup(list: BackupInfo[], host?: string): BackupInfo | undefined {
  const mine = host ? list.filter(b => b.host === host) : list;
  return mine.find(b => b.kind === 'daily') ?? mine[0];
}

/** Removes `host`'s backups of one kind beyond the newest `keep`. */
export function pruneBackups(dir: string, host: string, kind: BackupKind, keep: number): number {
  const stale = listBackups(dir).filter(b => b.host === host && b.kind === kind).slice(Math.max(1, Math.floor(keep)));
  for (const b of stale) unlinkSync(join(dir, b.name));
  return stale.length;
}

// ---- database helpers -----------------------------------------------------------

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

/** What the schema and count readers need from either kind of connection. */
interface Reader { prepare(sql: string): { get(...params: never[]): unknown; all(...params: never[]): unknown[] } }

/** The schema as text: every table and index definition, sorted. Two
 *  databases with the same fingerprint have the same shape. */
export function schemaFingerprint(db: Reader): string {
  const rows = db.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
  ).all() as Array<{ type: string; name: string; sql: string }>;
  return rows.map(r => `${r.type} ${r.name}: ${r.sql.replaceAll(/\s+/g, ' ')}`).join('\n');
}

export function tableCounts(db: Reader): Record<string, number> {
  const names = (db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>).map(r => r.name);
  const out: Record<string, number> = {};
  for (const name of names) {
    out[name] = (db.prepare(`SELECT count(*) AS c FROM "${name}"`).get() as { c: number }).c;
  }
  return out;
}

function isRitsuDatabase(db: Reader): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_definitions'").get();
}

/** Opens a copy the way boot opens the live database: core schema and
 *  migrations, then every store that creates tables of its own, then each
 *  plugin's migration. What this leaves behind is what a boot would. */
export function migrateCopy(path: string, plugins: readonly Plugin[]): Db {
  const db = openDatabase(path);
  ensureMemorySchema(db);
  ensureSettingsSchema(db);
  const host = new PluginHost(db, new SecretStore(db));
  for (const p of plugins) host.register(p);
  return db;
}

function removeWithSidecars(path: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${path}${suffix}`, { force: true });
}

/** `VACUUM INTO` a plaintext snapshot at `dest`, verified. */
function snapshotTo(db: Pick<DatabaseSync, 'exec'>, dest: string): void {
  db.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`);
  const bad = integrityError(dest);
  if (bad) { rmSync(dest, { force: true }); throw new Error(`snapshot failed integrity check: ${bad}`); }
}

/** Encrypts a plaintext snapshot into the folder under the next free name. */
async function encryptSnapshot(snapshot: string, dir: string, dataDir: string, host: string, kind: BackupKind, password: string): Promise<BackupInfo> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Names carry seconds; a second backup in the same second takes the next one.
  let at = new Date();
  while (existsSync(join(dir, fileName(host, kind, at)))) at = new Date(at.getTime() + 1000);
  const name = fileName(host, kind, at);
  const target = join(dir, name);
  const partial = join(dir, `.${name}.partial`);
  try {
    await encryptFile(snapshot, partial, password);
    matchOwner(partial, dataDir);
    renameSync(partial, target);
  } catch (e) {
    rmSync(partial, { force: true });
    throw e;
  }
  const info: BackupInfo = { name, host, kind, created_at: Math.floor(at.getTime() / 1000), size: statSync(target).size };
  logger.info('backup.created', { name, size: info.size, kind });
  return info;
}

/** Snapshot `db` and write it encrypted into `dir`. `db` may be a read-only
 *  connection: the CLI uses one so it never runs migrations as root. */
export async function createBackupFrom(
  db: Pick<DatabaseSync, 'exec'>, dbPath: string, dir: string, host: string, kind: BackupKind, password: string,
): Promise<BackupInfo> {
  const dataDir = dataDirOf(dbPath);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const snapshot = join(dataDir, `.backup-${randomUUID()}.db`);
  try {
    snapshotTo(db, snapshot);
    return await encryptSnapshot(snapshot, dir, dataDir, host, kind, password);
  } finally {
    removeWithSidecars(snapshot);
  }
}

/** Plaintext copies left by a crash mid-backup, mid-restore or mid-rehearsal. */
export function cleanScratch(dataDir: string): void {
  if (!existsSync(dataDir)) return;
  for (const name of readdirSync(dataDir)) {
    if (/^\.(backup|restore|rehearse)-/.test(name)) rmSync(join(dataDir, name), { recursive: true, force: true });
  }
}

// ---- pre-upgrade ------------------------------------------------------------------

interface PreUpgradeRecord { host: string; before: string; target: string; backup: string }

function readPreUpgradeRecord(dataDir: string): PreUpgradeRecord | null {
  try { return JSON.parse(readFileSync(join(dataDir, PRE_UPGRADE_RECORD), 'utf8')) as PreUpgradeRecord; }
  catch { return null; }
}

function writePreUpgradeRecord(dataDir: string, record: PreUpgradeRecord): void {
  const path = join(dataDir, PRE_UPGRADE_RECORD);
  writeFileSync(`${path}.partial`, JSON.stringify(record), { mode: 0o600 });
  matchOwner(`${path}.partial`, dataDir);
  renameSync(`${path}.partial`, path);
}

function clearPreUpgradeRecord(dataDir: string): void {
  rmSync(join(dataDir, PRE_UPGRADE_RECORD), { force: true });
}

export interface PreUpgradeOptions { dbPath: string; dir: string; host: string; plugins: readonly Plugin[] }

/**
 * Before a boot migrates the live database, this build's migrations run on a
 * copy. When they leave the schema as it was, nothing is written. When they
 * change it, the pre-migration snapshot goes to the backup folder encrypted,
 * and the boot refuses to go on without that copy. A migration that fails on
 * the copy aborts the boot with the live file untouched. No-op on a fresh install.
 */
export async function preUpgrade(opts: PreUpgradeOptions): Promise<BackupInfo | null> {
  const { dbPath, dir, host, plugins } = opts;
  if (!existsSync(dbPath)) return null;
  const dataDir = dataDirOf(dbPath);
  const id = randomUUID();
  const snapshot = join(dataDir, `.backup-${id}.db`);
  const copy = join(dataDir, `.rehearse-${id}.db`);
  try {
    const live = new DatabaseSync(dbPath, { readOnly: true });
    try { snapshotTo(live, snapshot); } finally { live.close(); }
    const before = readSchema(snapshot);
    copyFileSync(snapshot, copy);
    let target: string;
    try {
      const db = migrateCopy(copy, plugins);
      try { target = schemaFingerprint(db); } finally { db.close(); }
    } catch (e) {
      throw new StartupRefused(`this build's migrations fail on a copy of the database: ${(e as Error).message}. The live database was not touched.`);
    }
    if (before === target) return null;
    const record = readPreUpgradeRecord(dataDir);
    if (record?.host === host && record.target === target
        && parseName(record.backup)?.kind === 'pre-upgrade' && existsSync(join(dir, record.backup))) {
      logger.info('backup.pre-upgrade.stands', { name: record.backup });
      return null;
    }
    const password = loadPassword(dataDir);
    if (!password) {
      throw new StartupRefused(
        'this build changes the database schema and takes a backup first, but no backup password is set. '
        + 'Run `ritsu backup set-password`, then start again.',
      );
    }
    const info = await encryptSnapshot(snapshot, dir, dataDir, host, 'pre-upgrade', password);
    writePreUpgradeRecord(dataDir, { host, before, target, backup: info.name });
    return info;
  } finally {
    removeWithSidecars(snapshot);
    removeWithSidecars(copy);
  }
}

function readSchema(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return schemaFingerprint(db); } finally { db.close(); }
}

// ---- rehearsal ----------------------------------------------------------------------

export type RehearsalStage = 'decrypt' | 'integrity check' | 'schema check' | 'migration';

export class RehearsalError extends Error {
  constructor(readonly stage: RehearsalStage, message: string) {
    super(`rehearsal failed at ${stage}: ${message}`);
    this.name = 'RehearsalError';
  }
}

export interface TableCount { name: string; before: number | null; after: number | null }

export interface RehearsalReport {
  backup: string;
  schema_changed: boolean;
  duration_ms: number;
  tables: TableCount[];
  kept_at?: string;
}

/** Decrypts a backup into a fresh folder under `scratchParent`, checks it and
 *  runs this build's migrations on it. The live database is never opened. */
export async function rehearse(
  backupFile: string, password: string, plugins: readonly Plugin[], scratchParent: string, keep = false,
): Promise<RehearsalReport> {
  const started = Date.now();
  const work = join(scratchParent, `.rehearse-${randomUUID()}`);
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const copy = join(work, 'ritsu.db');
  let ok = false;
  try {
    try { await decryptFile(backupFile, copy, password); }
    catch (e) {
      if (e instanceof WrongPassword) throw e;
      throw new RehearsalError('decrypt', (e as Error).message);
    }
    const bad = integrityError(copy);
    if (bad) throw new RehearsalError('integrity check', bad);
    let before: Record<string, number>;
    let fpBefore: string;
    const plain = new DatabaseSync(copy, { readOnly: true });
    try {
      if (!isRitsuDatabase(plain)) throw new RehearsalError('schema check', 'not a ritsu database');
      before = tableCounts(plain);
      fpBefore = schemaFingerprint(plain);
    } finally { plain.close(); }
    let after: Record<string, number>;
    let fpAfter: string;
    try {
      const db = migrateCopy(copy, plugins);
      try { after = tableCounts(db); fpAfter = schemaFingerprint(db); } finally { db.close(); }
    } catch (e) {
      throw new RehearsalError('migration', (e as Error).message);
    }
    const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort((a, b) => a.localeCompare(b));
    ok = true;
    return {
      backup: basename(backupFile),
      schema_changed: fpBefore !== fpAfter,
      duration_ms: Date.now() - started,
      tables: names.map(name => ({ name, before: before[name] ?? null, after: after[name] ?? null })),
      ...(keep ? { kept_at: copy } : {}),
    };
  } finally {
    // Only a copy that migrated cleanly is worth keeping; a failed one goes with the folder.
    if (!(keep && ok)) rmSync(work, { recursive: true, force: true });
  }
}

// ---- restore --------------------------------------------------------------------------

export interface RestoreReport {
  restored_from: string;
  previous_saved_to: string | null;
  agents: number;
  conversations: number;
  memories: number;
}

function asideDirs(dataDir: string): string[] {
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir)
    .filter(n => n.startsWith(ASIDE_PREFIX) && parseStamp(n.slice(ASIDE_PREFIX.length)) && statSync(join(dataDir, n)).isDirectory())
    .sort((a, b) => b.localeCompare(a));
}

/** Databases a restore moved aside, oldest first beyond the newest `keep`, are removed. */
export function pruneAside(dataDir: string, keep: number): string[] {
  const removed: string[] = [];
  for (const name of asideDirs(dataDir).slice(keep)) {
    rmSync(join(dataDir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/** A restore that stopped between moving the live database aside and moving
 *  the copy in leaves no database and the real one in the newest aside folder.
 *  Opening the data dir would then create an empty database in silence. */
export function checkNotStranded(dbPath: string): void {
  if (existsSync(dbPath)) return;
  const dataDir = dataDirOf(dbPath);
  const aside = asideDirs(dataDir).find(n => existsSync(join(dataDir, n, basename(dbPath))));
  if (aside) {
    throw new StartupRefused(
      `no ${basename(dbPath)} in ${dataDir}, but ${join(dataDir, aside)} holds the database a restore moved aside; `
      + 'move it back from there, or remove the pre-restore folders to start on an empty database',
    );
  }
}

/** Replaces the live database with a backup, with no server running on it.
 *  The file keeps its own schema; the next boot migrates it, taking a
 *  pre-upgrade copy first as for any other database. */
export async function restore(backupFile: string, dbPath: string, password: string): Promise<RestoreReport> {
  const dataDir = dataDirOf(dbPath);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const staged = join(dataDir, `.restore-${randomUUID()}.db`);
  try {
    await decryptFile(backupFile, staged, password);
    const bad = integrityError(staged);
    if (bad) throw new Error(`backup failed the integrity check: ${bad}`);
    const counts = summarize(staged);
    const previous = swapIn(staged, dbPath);
    matchOwner(dbPath, dataDir);
    clearPreUpgradeRecord(dataDir);
    pruneAside(dataDir, ASIDE_KEEP);
    return { restored_from: backupFile, previous_saved_to: previous, ...counts };
  } finally {
    removeWithSidecars(staged);
  }
}

function summarize(path: string): { agents: number; conversations: number; memories: number } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (!isRitsuDatabase(db)) throw new Error('not a ritsu database');
    const count = (t: string): number => (db.prepare(`SELECT count(*) AS c FROM ${t}`).get() as { c: number }).c;
    return { agents: count('agent_definitions'), conversations: count('conversations'), memories: count('memories') };
  } finally { db.close(); }
}

/** Makes the staged copy the live database. The one it replaces moves into
 *  `pre-restore-<time>/` with its write-ahead log, never deleted; the log must
 *  travel with it, or SQLite would replay it onto the restored file. When a
 *  move fails, whatever was set aside comes back. */
function swapIn(staged: string, dbPath: string): string | null {
  const dataDir = dataDirOf(dbPath);
  if (!existsSync(dbPath)) { renameSync(staged, dbPath); return null; }
  const aside = join(dataDir, `${ASIDE_PREFIX}${stamp(new Date())}`);
  mkdirSync(aside, { mode: 0o700 });
  const moved: Array<[string, string]> = [];
  const undo = (cause: Error): Error => {
    const stuck: string[] = [];
    for (const [from, to] of moved.reverse()) {
      try { renameSync(to, from); } catch { stuck.push(to); }
    }
    if (stuck.length) return new Error(`${cause.message}; the previous database is in ${aside}, move it back by hand before starting the server`);
    rmSync(aside, { recursive: true, force: true });
    return new Error(`${cause.message}; the previous database is back in place`);
  };
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${dbPath}${suffix}`;
    if (!existsSync(from)) continue;
    const to = join(aside, `${basename(dbPath)}${suffix}`);
    try { renameSync(from, to); } catch (e) { throw undo(e as Error); }
    moved.push([from, to]);
  }
  try { renameSync(staged, dbPath); } catch (e) { throw undo(e as Error); }
  return aside;
}

// ---- the manager ---------------------------------------------------------------------

export interface BackupStatus { running: boolean; last_error: string | null; last_ok: BackupInfo | null }

export interface BackupManagerOptions { host?: string; plugins?: readonly Plugin[] }

export class BackupManager {
  readonly host: string;
  readonly dirSource: 'RITSU_BACKUP_DIR' | 'data dir';
  readonly status: BackupStatus = { running: false, last_error: null, last_ok: null };
  private readonly backupDir: string;
  private readonly plugins: readonly Plugin[];

  /** `db` is null for the filesystem-only operations (list, prune, delete).
   *  Those must not open the live database: opening it runs the migrations,
   *  so `ritsu backup list` would rebuild tables on a second connection while
   *  the service is running. */
  constructor(private readonly db: Db | null, private readonly dbPath: string, dirOverride?: string, opts: BackupManagerOptions = {}) {
    const r = resolveBackupDir(dbPath, dirOverride);
    this.backupDir = r.dir;
    this.dirSource = r.source;
    this.host = opts.host ?? hostName();
    this.plugins = opts.plugins ?? [];
  }

  private database(): Db {
    if (!this.db) throw new Error('this operation needs an open database');
    return this.db;
  }

  dir(): string { return this.backupDir; }
  dataDir(): string { return dataDirOf(this.dbPath); }

  passwordSet(): boolean { return loadPassword(this.dataDir()) !== null; }
  setPassword(password: string): void { savePassword(this.dataDir(), password); }

  /** Encrypted snapshot of the whole database into the folder. */
  async createBackup(kind: BackupKind = 'daily'): Promise<BackupInfo> {
    const db = this.database();
    const password = loadPassword(this.dataDir());
    if (!password) throw new Error('no backup password set: run `ritsu backup set-password` or set one on the Backups page');
    if (this.status.running) throw new Error('a backup is already running');
    this.status.running = true;
    try {
      const info = await createBackupFrom(db, this.dbPath, this.backupDir, this.host, kind, password);
      this.status.last_ok = info;
      this.status.last_error = null;
      return info;
    } catch (e) {
      this.status.last_error = (e as Error).message;
      throw e;
    } finally {
      this.status.running = false;
    }
  }

  listBackups(): BackupInfo[] { return listBackups(this.backupDir); }

  latest(host?: string): BackupInfo | undefined { return latestBackup(this.listBackups(), host); }

  /** Absolute path of a backup for download or rehearsal — a backup name, never a path. */
  pathFor(name: string): string | null {
    if (!parseName(name) || name !== basename(name)) return null;
    const p = join(this.backupDir, name);
    return existsSync(p) ? p : null;
  }

  deleteBackup(name: string): boolean {
    const p = this.pathFor(name);
    if (!p) return false;
    unlinkSync(p);
    logger.info('backup.deleted', { name });
    return true;
  }

  /** Keep this host's newest `keep` daily backups and its last few pre-upgrade
   *  copies. keep is floored at 1: a stored 0 would otherwise delete every
   *  snapshot, including the one taken seconds earlier. */
  prune(keep: number): number {
    const removed = pruneBackups(this.backupDir, this.host, 'daily', keep)
      + pruneBackups(this.backupDir, this.host, 'pre-upgrade', PRE_UPGRADE_KEEP);
    if (removed) logger.info('backup.pruned', { removed, kept: keep });
    return removed;
  }

  /** Whether this host's newest daily backup is older than `intervalHours`,
   *  or there is none. Never due without a password: there is nothing to write. */
  due(intervalHours: number): boolean {
    if (!this.passwordSet()) return false;
    const newest = this.listBackups().find(b => b.host === this.host && b.kind === 'daily');
    if (!newest) return true;
    return Date.now() - newest.created_at * 1000 >= intervalHours * 3_600_000;
  }

  /** `name` is a backup in the folder or `latest` (this host's). */
  async rehearse(name: string, keep = false): Promise<RehearsalReport> {
    const file = name === 'latest' ? this.latestPath() : this.pathFor(name);
    if (!file) throw new Error(name === 'latest' ? `no backups of ${this.host} in ${this.backupDir}` : `no such backup: ${name}`);
    const password = loadPassword(this.dataDir());
    if (!password) throw new Error('no backup password set on this machine');
    return rehearse(file, password, this.plugins, this.dataDir(), keep);
  }

  private latestPath(): string | null {
    const b = this.latest(this.host);
    return b ? join(this.backupDir, b.name) : null;
  }

  // ---- portability ------------------------------------------------------------

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

// ---- JSON export / import --------------------------------------------------------------

/** System tables excluded from the JSON export — credentials/tokens/audit, not
 *  "your data" (and not useful in plaintext). The encrypted backup still has
 *  them, so a restore is complete. */
const EXPORT_EXCLUDE = new Set([
  'mcp_tokens', 'mcp_token_usage', 'plugin_secrets', 'api_keys', 'admin_audit',
  'oauth_access_tokens', 'oauth_authorize_requests', 'oauth_authz_codes',
  'oauth_clients', 'oauth_refresh_tokens',
]);

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

/**
 * Rebuild a database from an `exportJson()` file. Writes a NEW file and refuses
 * to touch an existing one: the export deliberately omits credentials and audit
 * rows, so importing over a live database would produce a half-populated system
 * that looks whole. The encrypted backup is the restore path; this is the
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
  if (file.format !== EXPORT_FORMAT) {
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
    ensureMemorySchema(db);

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
