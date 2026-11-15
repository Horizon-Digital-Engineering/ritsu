/**
 * The parts behind /healthz and /readyz. Both are open, so every note is a
 * fixed phrase plus numbers, and every check is cheap: no network, no decrypts,
 * no writes.
 */
import { accessSync, constants as fsConstants, statfsSync } from 'node:fs';
import type { Db } from '../db.js';
import type { BackupInfo, BackupStatus } from '../backup.js';
import type { EngineId, SpeechStatus } from '../speech/index.js';
import { published } from '../speech/model.js';
import { CLAUDE_NS } from '../model/claude-direct-dispatcher.js';
import { masterKeyStatus, tryDeriveSubkey } from '../util/secret-crypto.js';
import { logger } from '../util/log.js';
import type { HealthSummary, Part, PartId } from './types.js';

export interface PartsDeps {
  db: Pick<Db, 'prepare'>;
  dataDir: string;
  agentsLoaded(): number;
  secrets: { has(namespace: string, name: string): boolean };
  mcpListening(): boolean;
  /** Absent = voice is not available in this process. */
  speech?: { status(): Pick<SpeechStatus, 'choice' | 'engine' | 'model'> };
  backups: {
    readonly host: string;
    readonly status: BackupStatus;
    passwordSet(): boolean;
    listBackups(): BackupInfo[];
  };
  backupIntervalHours(): number;
  schedulerRunning(): boolean;
  plugins: { manifests(): ReadonlyArray<{ enabled: boolean }> };
  pluginFailures(): number;
  runningChannels(): number[];
  now?: () => number;
  freeBytes?: (dir: string) => number;
  masterKey?: { present(): boolean; usable(): boolean };
}

type Verdict = Pick<Part, 'status' | 'note'>;

const LABELS: Record<PartId, string> = {
  database: 'Database',
  secrets: 'Secret storage',
  subscription: 'Subscription token',
  agents: 'Agents',
  mcp: 'MCP server',
  voice: 'Voice',
  backups: 'Backups',
  scheduler: 'Scheduler',
  plugins: 'Plugins',
  channels: 'Channels',
};

const MiB = 2 ** 20;
const GiB = 2 ** 30;
const HOUR_MS = 3_600_000;
/** The backup folder may be a slow network share. */
const LISTING_TTL_MS = 60_000;
/** The tick runs every minute; this is well past a missed tick or two. */
const OVERDUE_MS = 20 * 60_000;

const ok = (note: string): Verdict => ({ status: 'ok', note });
const warn = (note: string): Verdict => ({ status: 'warn', note });
const fail = (note: string): Verdict => ({ status: 'fail', note });
const off = (note: string): Verdict => ({ status: 'off', note });

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function gb(bytes: number): string {
  const g = bytes / GiB;
  return String(g < 10 ? Math.floor(g * 10) / 10 : Math.floor(g));
}

function count(db: PartsDeps['db'], sql: string): number {
  return Number((db.prepare(sql).get() as { n: number }).n);
}

function diskFree(dir: string): number {
  const s = statfsSync(dir);
  return s.bavail * s.bsize;
}

function database(d: PartsDeps): Verdict {
  try { d.db.prepare('SELECT 1').get(); } catch { return fail('not answering'); }
  try { accessSync(d.dataDir, fsConstants.W_OK); } catch { return fail('data folder not writable'); }
  let free: number;
  try { free = (d.freeBytes ?? diskFree)(d.dataDir); } catch { return ok('open'); }
  if (free < 256 * MiB) return fail(`disk nearly full, ${Math.floor(free / MiB)} MB free`);
  if (free < 2 * GiB) return warn(`low disk, ${gb(free)} GB free`);
  return ok(`open, ${gb(free)} GB free`);
}

// Rows that hold ciphertext; without a key they are unreadable.
const ENCRYPTED_ROWS = `SELECT
  (SELECT COUNT(*) FROM plugin_secrets WHERE value_enc LIKE 'enc:%')
  + (SELECT COUNT(*) FROM api_keys WHERE revoked_at IS NULL AND instr(key_enc, 'enc:') > 0)
  + (SELECT COUNT(*) FROM channels WHERE instr(config, '"enc:') > 0) AS n`;

const realKey = {
  present: () => masterKeyStatus().ok,
  // With no key and a writable key folder this would create one, so it runs only once a key exists.
  usable: () => tryDeriveSubkey('health') !== null,
};

function secrets(d: PartsDeps): Verdict {
  const key = d.masterKey ?? realKey;
  if (key.present()) return key.usable() ? ok('key loaded') : fail('key present but unusable');
  return count(d.db, ENCRYPTED_ROWS) > 0
    ? fail("key missing; stored secrets can't be read")
    : warn("no key yet; secrets can't be saved");
}

function subscription(d: PartsDeps): Verdict {
  if (count(d.db, "SELECT COUNT(*) AS n FROM agent_definitions WHERE enabled = 1 AND runtime = 'direct'") === 0) {
    return off('no agents need it');
  }
  // A stored token wins over the environment when an agent is built.
  if (d.secrets.has(CLAUDE_NS, 'oauth_token')) return ok('stored');
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return ok('from the environment');
  return warn('missing');
}

function agents(d: PartsDeps): Verdict {
  const enabled = count(d.db, 'SELECT COUNT(*) AS n FROM agent_definitions WHERE enabled = 1');
  const loaded = d.agentsLoaded();
  if (enabled === 0) return warn('none enabled');
  if (loaded < enabled) return fail(`${loaded} of ${enabled} loaded`);
  return ok(`${loaded} loaded`);
}

function engineLabel(id: EngineId, model: string | null = null): string {
  if (id === 'local') return 'Whisper server';
  if (id === 'openai') return 'OpenAI gpt-transcribe';
  // Only a published model name: the manifest is a file anyone with the data folder can edit.
  return model && published(model) ? `built-in Whisper (${model})` : 'built-in Whisper';
}

function voice(d: PartsDeps): Verdict {
  if (!d.speech) return off('not available');
  const st = d.speech.status();
  if (st.choice === 'off') return off('turned off');
  if (st.engine) return ok(engineLabel(st.engine, st.model));
  if (st.choice === 'auto') return warn('not set up');
  return fail(`${engineLabel(st.choice)} chosen but not available`);
}

function backups(d: PartsDeps, newestDaily: () => BackupInfo | undefined, now: number): Verdict {
  let hasPassword: boolean;
  try { hasPassword = d.backups.passwordSet(); } catch { return fail('password file unreadable'); }
  if (!hasPassword) return warn('off: no backup password');
  if (d.backups.status.running) return ok('running now');
  if (d.backups.status.last_error) return fail('last attempt failed');
  const newest = newestDaily();
  if (!newest) return warn('no daily backup yet');
  const hours = (now - newest.created_at * 1000) / HOUR_MS;
  const interval = d.backupIntervalHours();
  const note = hours < 1 ? 'newest under 1 h old' : `newest ${Math.floor(hours)} h old`;
  if (hours > 2 * interval) return fail(note);
  if (hours > interval + 1) return warn(note);
  return ok(note);
}

interface JobRow { enabled: number; next_run_at: number | null; consecutive_failures: number | null; disabled_reason: string | null }

function scheduler(d: PartsDeps, now: number): Verdict {
  const rows = d.db.prepare(`
    SELECT j.enabled, s.next_run_at, s.consecutive_failures, s.disabled_reason
    FROM scheduler_jobs j LEFT JOIN scheduler_job_state s ON s.job_id = j.id
  `).all() as JobRow[];
  let live = 0, stopped = 0, failing = 0, overdue = 0;
  for (const r of rows) {
    // Turned off by the operator, or a one-shot that has run: neither is a fault.
    if (r.enabled !== 1 || r.disabled_reason === 'exhausted') continue;
    if (r.disabled_reason) { stopped++; continue; }
    live++;
    if ((r.consecutive_failures ?? 0) > 0) failing++;
    if (r.next_run_at !== null && r.next_run_at < now - OVERDUE_MS) overdue++;
  }
  if (live + stopped === 0) return off('no jobs');
  if (!d.schedulerRunning()) return fail('not running');
  if (stopped) return fail(`${stopped} stopped after failures`);
  if (failing) return warn(`${failing} of ${live} failing`);
  if (overdue) return warn(`${overdue} overdue`);
  return ok(`${plural(live, 'job')}, none failing`);
}

function plugins(d: PartsDeps): Verdict {
  const loaded = d.plugins.manifests();
  const failed = d.pluginFailures();
  if (loaded.length === 0 && failed === 0) return off('none installed');
  if (failed) return fail(`${failed} failed to load`);
  const disabled = loaded.filter(m => !m.enabled).length;
  return ok(disabled ? `${loaded.length} loaded, ${disabled} off` : `${loaded.length} loaded`);
}

function channels(d: PartsDeps): Verdict {
  // json_valid first: one malformed row must not fail the whole part.
  const rows = d.db.prepare(`
    SELECT id, CASE WHEN json_valid(config) THEN json_extract(config, '$.chat_id') END AS chat_id
    FROM channels WHERE enabled = 1
  `).all() as Array<{ id: number; chat_id: number | null }>;
  if (rows.length === 0) return off('none set up');
  const running = new Set(d.runningChannels());
  const down = rows.filter(r => !running.has(Number(r.id))).length;
  if (down) return fail(`${down} of ${rows.length} not running`);
  const unlinked = rows.filter(r => r.chat_id === null).length;
  if (unlinked) return warn(`${unlinked} not linked to a chat`);
  return ok(`${rows.length} running`);
}

/** Returns a function that checks every part, in the fixed order. A part whose
 *  check throws is its own failure; the call itself never throws. */
export function createParts(d: PartsDeps): () => Part[] {
  const now = d.now ?? Date.now;
  let listing: { at: number; list: BackupInfo[] } | null = null;

  const newestDaily = (): BackupInfo | undefined => {
    const t = now();
    if (!listing || t - listing.at >= LISTING_TTL_MS) listing = { at: t, list: d.backups.listBackups() };
    const mine = (b: BackupInfo | null | undefined): b is BackupInfo => b?.host === d.backups.host && b.kind === 'daily';
    const listed = listing.list.find(mine);
    // A backup finished since the cached listing is still the newest one.
    const justMade = mine(d.backups.status.last_ok) ? d.backups.status.last_ok : undefined;
    if (!listed) return justMade;
    return justMade && justMade.created_at > listed.created_at ? justMade : listed;
  };

  const checks: Array<[PartId, () => Verdict]> = [
    ['database', () => database(d)],
    ['secrets', () => secrets(d)],
    ['subscription', () => subscription(d)],
    ['agents', () => agents(d)],
    ['mcp', () => (d.mcpListening() ? ok('listening') : fail('not listening'))],
    ['voice', () => voice(d)],
    ['backups', () => backups(d, newestDaily, now())],
    ['scheduler', () => scheduler(d, now())],
    ['plugins', () => plugins(d)],
    ['channels', () => channels(d)],
  ];

  return () => checks.map(([id, check]): Part => {
    try {
      return { id, label: LABELS[id], ...check() };
    } catch (e) {
      logger.warn('health.part-failed', { part: id, err: (e as Error).message });
      return { id, label: LABELS[id], status: 'fail', note: 'check failed' };
    }
  });
}

export function summarize(parts: Part[], version: string, uptimeS: number): HealthSummary {
  let status: HealthSummary['status'] = 'ok';
  if (parts.some(p => p.status === 'fail')) status = 'fail';
  else if (parts.some(p => p.status === 'warn')) status = 'warn';
  return { name: 'ritsu', status, version, uptime_s: uptimeS, parts };
}
