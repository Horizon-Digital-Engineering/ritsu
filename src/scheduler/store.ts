import type { z } from 'zod';
import type { Db } from '../db.js';
import { logger } from '../util/log.js';
import {
  JobSchema,
  MAX_TRIGGER_STATE_BYTES,
  type DisabledReason,
  type Job,
  type JobRun,
  type JobState,
  type RunStatus,
} from './types.js';

/**
 * Input shape, not output shape. Typing these as `Job['schedule']` made every
 * zod `.default()` unreachable for in-process callers — they had to supply
 * `tz`, `stagger_ms` and every delivery field by hand.
 */
export type JobUpsert = Pick<z.input<typeof JobSchema>, 'id' | 'name'> &
  Partial<Omit<z.input<typeof JobSchema>, 'id' | 'name'>> &
  Pick<z.input<typeof JobSchema>, 'schedule' | 'payload'>;

/**
 * A stored row that will not parse. It cannot be returned from `list()` —
 * there is no `Job` to build — so it needs its own shape or it is visible
 * nowhere but the log.
 */
export interface UnreadableJob {
  id: string;
  name: string | null;
  error: string;
}

export interface JobStore {
  list(includeDisabled?: boolean): Job[];
  /**
   * Rows that fail to parse. `list()` cannot report these, so an operator has
   * no way to see that a job exists, let alone delete or repair it. Disabling
   * a row it cannot read stops the tick-loop noise but also removes the last
   * trace of it from every surface, which is worse than the noise was.
   */
  unreadable(): UnreadableJob[];
  read(id: string): Job | null;
  upsert(input: JobUpsert): Job;
  delete(id: string): boolean;
  setEnabled(id: string, enabled: boolean): void;

  state(id: string): JobState | null;
  due(now: number): Job[];
  setNextRun(id: string, at: number | null): void;
  /**
   * Take exclusive ownership of a due job by moving its `next_run_at` in one
   * statement. Returns false when someone else got there first.
   */
  claim(id: string, expectedNextRun: number, newNextRun: number | null): boolean;
  /** Stop a job and record why. The only thing that writes `disabled_reason`. */
  disable(id: string, reason: DisabledReason): void;
  recordOutcome(id: string, at: number, status: RunStatus): void;
  /** Narrow update, so a long agent turn can't clobber concurrent edits. */
  setConversationId(id: string, conversationId: number): void;

  triggerState(id: string): unknown;
  setTriggerState(id: string, state: unknown): void;

  startRun(id: string, at: number): number;
  finishRun(runId: number, at: number, status: RunStatus, output: string | null, error: string | null): void;
  /** Terminates runs abandoned by a previous process. */
  reconcileOnBoot(): number;
  latestOutput(id: string, notBefore?: number): string | null;
  runs(id: string, limit: number): JobRun[];
  /** Trims run history to the newest N per job. */
  pruneRuns(keepPerJob: number): number;
}

interface JobDbRow {
  id: string;
  name: string;
  enabled: number;
  schedule: string;
  payload: string;
  delivery: string;
  trigger_def: string | null;
  context_from: string;
  owner: string | null;
}

interface StateDbRow {
  job_id: string;
  next_run_at: number | null;
  last_run_at: number | null;
  last_status: string | null;
  consecutive_failures: number;
  disabled_reason: string | null;
  trigger_state: string | null;
}

function parseJob(row: JobDbRow): Job {
  return JobSchema.parse({
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    schedule: JSON.parse(row.schedule) as unknown,
    payload: JSON.parse(row.payload) as unknown,
    delivery: JSON.parse(row.delivery) as unknown,
    trigger: row.trigger_def ? (JSON.parse(row.trigger_def) as unknown) : null,
    context_from: JSON.parse(row.context_from) as unknown,
    owner: row.owner,
  });
}

/**
 * Parse a batch, skipping rows that don't. One row written by an older build
 * would otherwise throw for the whole query — which stopped every job on the
 * next tick, and prevented the process from booting at all via `start()`.
 * Matches how channel rows are handled: one bad row kills one thing.
 */
function parseRows(rows: JobDbRow[], onBad?: (id: string, err: string) => void): Job[] {
  const out: Job[] = [];
  for (const row of rows) {
    try { out.push(parseJob(row)); }
    catch (err) {
      const detail = (err as Error).message;
      logger.error('scheduler.job-unreadable', { job: row.id, err: detail });
      // Skipping alone left the row invisible to every listing while its state
      // still read armed and due — so it logged on every tick, forever, and no
      // surface could show it. Marking it stops the noise and makes it findable.
      onBad?.(row.id, detail);
    }
  }
  return out;
}

export class SqliteJobStore implements JobStore {
  constructor(private readonly db: Db) {}

  list(includeDisabled = false): Job[] {
    const sql = includeDisabled
      ? 'SELECT * FROM scheduler_jobs ORDER BY name'
      : `SELECT j.* FROM scheduler_jobs j
         LEFT JOIN scheduler_job_state s ON s.job_id = j.id
         WHERE j.enabled = 1 AND (s.disabled_reason IS NULL)
         ORDER BY j.name`;
    return parseRows(this.db.prepare(sql).all() as JobDbRow[], id => this.disable(id, 'unreadable'));
  }

  unreadable(): UnreadableJob[] {
    const rows = this.db.prepare('SELECT * FROM scheduler_jobs ORDER BY name').all() as JobDbRow[];
    const out: UnreadableJob[] = [];
    for (const row of rows) {
      try { parseJob(row); }
      catch (err) {
        // `name` is read straight off the row rather than the parsed job,
        // because the parse is what failed. It may itself be missing.
        out.push({ id: row.id, name: typeof row.name === 'string' ? row.name : null, error: (err as Error).message });
      }
    }
    return out;
  }

  read(id: string): Job | null {
    const row = this.db.prepare('SELECT * FROM scheduler_jobs WHERE id = ?').get(id) as JobDbRow | undefined;
    if (!row) return null;
    try { return parseJob(row); }
    catch (err) { logger.error('scheduler.job-unreadable', { job: id, err: (err as Error).message }); return null; }
  }

  upsert(input: JobUpsert): Job {
    const job = JobSchema.parse(input);
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO scheduler_jobs (id, name, enabled, schedule, payload, delivery, trigger_def, context_from, owner)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          enabled = excluded.enabled,
          schedule = excluded.schedule,
          payload = excluded.payload,
          delivery = excluded.delivery,
          trigger_def = excluded.trigger_def,
          context_from = excluded.context_from,
          owner = excluded.owner,
          updated_at = strftime('%s','now')
      `).run(
        job.id, job.name, job.enabled ? 1 : 0,
        JSON.stringify(job.schedule), JSON.stringify(job.payload), JSON.stringify(job.delivery),
        job.trigger ? JSON.stringify(job.trigger) : null,
        JSON.stringify(job.context_from), job.owner,
      );
      // Editing a job must not clear its failure streak or next run.
      this.db.prepare(
        'INSERT INTO scheduler_job_state (job_id) VALUES (?) ON CONFLICT(job_id) DO NOTHING',
      ).run(job.id);
    })();
    return job;
  }

  delete(id: string): boolean {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM scheduler_runs WHERE job_id = ?').run(id);
      this.db.prepare('DELETE FROM scheduler_job_state WHERE job_id = ?').run(id);
      return this.db.prepare('DELETE FROM scheduler_jobs WHERE id = ?').run(id).changes > 0;
    })();
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db.transaction(() => {
      this.db.prepare(
        "UPDATE scheduler_jobs SET enabled = ?, updated_at = strftime('%s','now') WHERE id = ?",
      ).run(enabled ? 1 : 0, id);
      if (enabled) {
        this.db.prepare(
          'UPDATE scheduler_job_state SET disabled_reason = NULL, consecutive_failures = 0 WHERE job_id = ?',
        ).run(id);
      }
    })();
    // `next_run_at` is deliberately left to the caller: only it knows the clock
    // to compute from. A job re-enabled without re-arming is inert, so callers
    // must follow with setNextRun.
  }

  state(id: string): JobState | null {
    const row = this.db.prepare('SELECT * FROM scheduler_job_state WHERE job_id = ?').get(id) as StateDbRow | undefined;
    if (!row) return null;
    return {
      job_id: row.job_id,
      next_run_at: row.next_run_at,
      last_run_at: row.last_run_at,
      last_status: (row.last_status as RunStatus | null) ?? null,
      consecutive_failures: row.consecutive_failures,
      disabled_reason: row.disabled_reason,
    };
  }

  due(now: number): Job[] {
    const rows = this.db.prepare(`
      SELECT j.* FROM scheduler_jobs j
      JOIN scheduler_job_state s ON s.job_id = j.id
      WHERE j.enabled = 1
        AND s.disabled_reason IS NULL
        AND s.next_run_at IS NOT NULL
        AND s.next_run_at <= ?
      ORDER BY s.next_run_at
    `).all(now) as JobDbRow[];
    return parseRows(rows, id => this.disable(id, 'unreadable'));
  }

  setNextRun(id: string, at: number | null): void {
    // Arming clears the stop reason: a job cannot be both scheduled and given
    // up on. Without this, re-creating an auto-disabled or exhausted job set a
    // next run that `due()` then filtered out by reason — every surface said
    // "scheduled", and it never ran again.
    const res = this.db.prepare(
      at === null
        ? 'UPDATE scheduler_job_state SET next_run_at = ? WHERE job_id = ?'
        : 'UPDATE scheduler_job_state SET next_run_at = ?, disabled_reason = NULL WHERE job_id = ?',
    ).run(at, id);
    // A missing state row means the job can never be selected by due(), which
    // inner-joins it. Silently affecting zero rows made that invisible.
    if (res.changes === 0) {
      this.db.prepare('INSERT INTO scheduler_job_state (job_id, next_run_at) VALUES (?, ?)').run(id, at);
    }
  }

  claim(id: string, expectedNextRun: number, newNextRun: number | null): boolean {
    // Conditional on the value we read, so two overlapping ticks cannot both
    // take the same job. This replaces an in-process guard that only compared
    // against jobs already started, and so allowed a stale batch to re-run.
    return this.db.prepare(`
      UPDATE scheduler_job_state SET next_run_at = ?
      WHERE job_id = ? AND next_run_at = ?
    `).run(newNextRun, id, expectedNextRun).changes === 1;
  }

  disable(id: string, reason: DisabledReason): void {
    this.db.prepare(
      'UPDATE scheduler_job_state SET next_run_at = NULL, disabled_reason = ? WHERE job_id = ?',
    ).run(reason, id);
  }

  recordOutcome(id: string, at: number, status: RunStatus): void {
    // A skip is the trigger working; a gate error is not, and must count.
    const isFailure = status === 'error' || status === 'gate_error';
    this.db.prepare(`
      UPDATE scheduler_job_state
      SET last_run_at = ?, last_status = ?,
          consecutive_failures = ${isFailure ? 'consecutive_failures + 1' : '0'}
      WHERE job_id = ?
    `).run(at, status, id);
  }

  setConversationId(id: string, conversationId: number): void {
    // Targeted, not a whole-row rewrite from a snapshot taken minutes earlier —
    // that silently reverted concurrent edits and resurrected deleted jobs.
    this.db.prepare(`
      UPDATE scheduler_jobs
      SET payload = json_set(payload, '$.conversation_id', ?),
          updated_at = strftime('%s','now')
      WHERE id = ? AND json_extract(payload, '$.kind') = 'agent_turn'
    `).run(conversationId, id);
  }

  triggerState(id: string): unknown {
    const row = this.db.prepare('SELECT trigger_state FROM scheduler_job_state WHERE job_id = ?')
      .get(id) as { trigger_state: string | null } | undefined;
    if (!row?.trigger_state) return null;
    try { return JSON.parse(row.trigger_state) as unknown; } catch { return null; }
  }

  setTriggerState(id: string, state: unknown): void {
    let encoded: string | null = null;
    if (state !== null && state !== undefined) {
      const json = JSON.stringify(state);
      // Measured in bytes, not UTF-16 units — the constant says bytes, and
      // multi-byte content was slipping through at up to three times the cap.
      const bytes = Buffer.byteLength(json, 'utf8');
      if (bytes > MAX_TRIGGER_STATE_BYTES) {
        throw new Error(`trigger state ${bytes}B exceeds ${MAX_TRIGGER_STATE_BYTES}B`);
      }
      encoded = json;
    }
    this.db.prepare('UPDATE scheduler_job_state SET trigger_state = ? WHERE job_id = ?').run(encoded, id);
  }

  startRun(id: string, at: number): number {
    // Non-terminal until finishRun says otherwise, so a process killed mid-run
    // leaves an honest record instead of a fabricated success.
    return this.db.prepare(
      "INSERT INTO scheduler_runs (job_id, started_at, status) VALUES (?, ?, 'running')",
    ).run(id, at).lastInsertRowid;
  }

  finishRun(runId: number, at: number, status: RunStatus, output: string | null, error: string | null): void {
    this.db.prepare(
      'UPDATE scheduler_runs SET finished_at = ?, status = ?, output = ?, error = ? WHERE id = ?',
    ).run(at, status, output, error, runId);
  }

  reconcileOnBoot(): number {
    // Mirrors what the approval store does for turns that died with their
    // process: nothing can finish these, so leaving them 'running' forever
    // would make every listing lie.
    return this.db.prepare(`
      UPDATE scheduler_runs
      SET status = 'error', error = 'interrupted by shutdown', finished_at = started_at
      WHERE status = 'running'
    `).run().changes;
  }

  latestOutput(id: string, notBefore?: number): string | null {
    const row = this.db.prepare(`
      SELECT output, started_at FROM scheduler_runs
      WHERE job_id = ? AND status = 'ok' AND output IS NOT NULL
      ORDER BY started_at DESC LIMIT 1
    `).get(id) as { output: string | null; started_at: number } | undefined;
    if (!row) return null;
    // Without a bound, a broken collector's week-old output keeps being served
    // to its summarizer as if it were current.
    if (notBefore !== undefined && row.started_at < notBefore) return null;
    return row.output;
  }

  runs(id: string, limit: number): JobRun[] {
    return this.db.prepare(
      'SELECT * FROM scheduler_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?',
    ).all(id, limit) as JobRun[];
  }

  pruneRuns(keepPerJob: number): number {
    // History grows without bound while definitions do not, and the daily
    // backup keeps fourteen copies of whatever is on disk.
    return this.db.prepare(`
      DELETE FROM scheduler_runs WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY started_at DESC) AS rn
          FROM scheduler_runs
        ) WHERE rn > ?
      )
    `).run(keepPerJob).changes;
  }
}
