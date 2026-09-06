/**
 * The tick loop. Finds due jobs, gates them through their trigger, runs the
 * payload, delivers the output, and records what happened.
 *
 * Dependencies are narrow interfaces rather than the concrete registry and
 * host, so the loop can be exercised against fakes — scheduling bugs that only
 * appear at 3am are not debuggable any other way.
 */
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { logger } from '../util/log.js';
import { fenceUntrusted } from '../util/untrusted.js';
import { nextRun, catchUp } from './schedule.js';
import { MAX_CONSECUTIVE_FAILURES, type Job, type RunStatus } from './types.js';
import type { JobStore } from './store.js';

/** What the runner needs from the channel registry. */
export interface JobDelivery {
  send(channelId: number, text: string): Promise<void>;
  runningIds(): number[];
}

/** What the runner needs from the agent host. Mirrors ChannelAgentHost. */
export interface JobAgentHost {
  get(id: string): {
    onMessage(req: { message: string; conversation_id?: number; caller_label?: string | null }):
      Promise<{ reply: string; conversation_id: number }>;
  };
}

export interface RunnerDeps {
  store: JobStore;
  delivery: JobDelivery;
  agents: JobAgentHost;
  /** Injectable so tests can drive a fixed clock. */
  now?: () => number;
}

interface PayloadResult {
  status: RunStatus;
  output: string;
  error: string | null;
}

const TICK_MS = 60_000;
/** An agent turn has no internal timeout; without one a wedged host stalls a job forever. */
const AGENT_TURN_TIMEOUT_MS = 10 * 60_000;
/** Run history kept per job. Definitions are tiny; history is not, and it's backed up daily. */
const KEEP_RUNS_PER_JOB = 200;
/** How stale an upstream output may be before a downstream job refuses it. */
const CONTEXT_MAX_AGE_MS = 36 * 3_600_000;

export class SchedulerRunner {
  private readonly store: JobStore;
  private readonly delivery: JobDelivery;
  private readonly agents: JobAgentHost;
  private readonly now: () => number;

  /**
   * Guards against a slow tick overlapping the next one. Without it, a second
   * tick works from a due-list the first has not finished, and both deliver.
   */
  private ticking = false;

  /**
   * Last failure alert per job. In memory, so a restart re-alerts once for a
   * still-broken job. That is a real gap during a crash loop and is called out
   * rather than papered over.
   */
  private readonly lastAlertAt = new Map<string, number>();

  private timer: NodeJS.Timeout | null = null;

  constructor(deps: RunnerDeps) {
    this.store = deps.store;
    this.delivery = deps.delivery;
    this.agents = deps.agents;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Close out runs abandoned by a previous process, re-arm anything that came
   * due while it was down, then start ticking. Overdue runs move forward and
   * are never replayed — a week of downtime must not deliver a week of
   * reminders at once.
   */
  start(): void {
    const now = this.now();

    const stranded = this.store.reconcileOnBoot();
    if (stranded > 0) logger.warn('scheduler.runs-reconciled', { count: stranded });

    for (const job of this.store.list()) {
      const state = this.store.state(job.id);
      // A job the scheduler gave up on stays down across restarts. Re-arming on
      // a null next_run_at alone resurrected every auto-disabled job on deploy.
      if (state?.disabled_reason) continue;

      const next = state?.next_run_at ?? null;
      if (next !== null && next > now) continue;

      let computed: number | null;
      try {
        computed = next === null
          ? nextRun(job.schedule, now, state?.last_run_at ?? null)
          : catchUp(job.schedule, now, state?.last_run_at ?? null, next);
      } catch (err) {
        // Only a computation failure retires a job. Covering the write here too
        // meant one transient lock permanently stopped a healthy schedule.
        this.store.disable(job.id, 'uncomputable-schedule');
        logger.error('scheduler.schedule-invalid', { job: job.id, err: (err as Error).message });
        continue;
      }
      if (computed === null) {
        this.store.disable(job.id, 'exhausted');
        logger.info('scheduler.exhausted', { job: job.id });
      } else {
        this.store.setNextRun(job.id, computed);
      }
    }

    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref();
    logger.info('scheduler.started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass. Public so tests can drive it without waiting on a timer. */
  async tick(): Promise<void> {
    if (this.ticking) { logger.warn('scheduler.tick-overlap'); return; }
    this.ticking = true;
    try {
      const now = this.now();
      let due: Job[];
      try { due = this.store.due(now); }
      catch (err) { logger.error('scheduler.due-query-failed', { err: (err as Error).message }); return; }

      // Sequentially, not in parallel: these mostly end in a message to the
      // same human, and a burst of six at once reads as a malfunction.
      for (const job of due) {
        try { await this.runJob(job, this.now()); }
        catch (err) { logger.error('scheduler.run-crashed', { job: job.id, err: (err as Error).message }); }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async runJob(job: Job, now: number): Promise<void> {
    const state = this.store.state(job.id);
    const dueAt = state?.next_run_at;
    if (dueAt === null || dueAt === undefined || dueAt > now) return;

    // Compute before claiming so a computation failure is distinguishable from
    // a write failure — conflating them let a transient lock permanently retire
    // a healthy job.
    let following: number | null;
    try {
      // Anchored on the slot being fired, not on `last_run_at` (not yet
      // written) or on `now` (the tick, which would reintroduce drift). This is
      // also what tells a one-shot it has run.
      following = nextRun(job.schedule, now, dueAt);
    } catch (err) {
      this.store.disable(job.id, 'uncomputable-schedule');
      logger.error('scheduler.schedule-uncomputable', { job: job.id, err: (err as Error).message });
      return;
    }

    // Atomic: whoever moves next_run_at owns this run. A second tick working
    // from a stale due-list loses here instead of delivering a duplicate.
    if (!this.store.claim(job.id, dueAt, following)) {
      logger.warn('scheduler.claim-lost', { job: job.id });
      return;
    }
    if (following === null) {
      this.store.disable(job.id, 'exhausted');
      logger.info('scheduler.exhausted', { job: job.id });
    }

    const runId = this.store.startRun(job.id, now);

    const gate = await this.evaluateTrigger(job);
    if (gate.status !== 'fire') {
      await this.finishGatedRun(job, runId, dueAt, gate);
      return;
    }

    const result = await this.executePayload(job, gate.message);
    let finishedAt = this.now();

    if (result.status === 'ok' && result.output.trim()) {
      const delivered = await this.deliver(job, result.output);
      if (!delivered) {
        // Every target failed. Reporting success here made "the job ran" and
        // "you received it" two different facts with no way to tell them apart.
        result.status = 'error';
        result.error = 'delivery failed on every channel';
      }
      finishedAt = this.now();
    }

    this.store.finishRun(runId, finishedAt, result.status, result.output || null, result.error);
    this.store.recordOutcome(job.id, dueAt, result.status);

    if (result.status === 'ok') {
      await this.persistTriggerState(job, runId, dueAt, gate.state, result);
    } else {
      await this.alertFailure(job, result.error ?? 'unknown error', finishedAt);
      this.maybeAutoDisable(job);
    }
  }

  private async finishGatedRun(
    job: Job,
    runId: number,
    dueAt: number,
    gate: { status: 'fire' | 'declined' | 'error'; state?: unknown; error?: string },
  ): Promise<void> {
    // A decline still updates the baseline. A change-detector that only
    // persists on a fire can never move its reference point, so once it
    // declines it declines forever.
    if (gate.status === 'declined' && gate.state !== undefined) {
      try { this.store.setTriggerState(job.id, gate.state); }
      catch (err) { logger.warn('scheduler.trigger-state-rejected', { job: job.id, err: (err as Error).message }); }
    }
    const status: RunStatus = gate.status === 'declined' ? 'skipped' : 'gate_error';
    this.store.finishRun(runId, this.now(), status, null, gate.error ?? null);
    this.store.recordOutcome(job.id, dueAt, status);
    if (status === 'gate_error') {
      // A broken gate is a broken job. Recording it as a skip meant a typo'd
      // command silenced a job forever while resetting its failure streak.
      await this.alertFailure(job, `trigger failed: ${gate.error ?? 'unknown'}`, this.now());
      this.maybeAutoDisable(job);
    }
  }

  private async persistTriggerState(
    job: Job,
    runId: number,
    dueAt: number,
    state: unknown,
    result: PayloadResult,
  ): Promise<void> {
    if (state === undefined) return;
    try { this.store.setTriggerState(job.id, state); }
    catch (err) {
      // Leaving it unset would make the gate permanently stateless and
      // re-fire every tick — the exact outcome the cap exists to prevent.
      logger.error('scheduler.trigger-state-rejected', { job: job.id, err: (err as Error).message });
      this.store.finishRun(runId, this.now(), 'error', result.output || null, (err as Error).message);
      this.store.recordOutcome(job.id, dueAt, 'error');
      // Every other error path alerts; this one silently left the gate
      // stateless, which makes it re-fire every tick.
      await this.alertFailure(job, `trigger state rejected: ${(err as Error).message}`, this.now());
      this.maybeAutoDisable(job);
    }
  }

  private async evaluateTrigger(
    job: Job,
  ): Promise<{ status: 'fire' | 'declined' | 'error'; message?: string; state?: unknown; error?: string }> {
    if (!job.trigger) return { status: 'fire' };
    const prev = this.store.triggerState(job.id);
    try {
      const out = await runCommand(job.trigger.command, job.trigger.timeout_s, 64 * 1024, {
        RITSU_TRIGGER_STATE: prev === null ? '' : JSON.stringify(prev),
      });
      const parsed = JSON.parse(out.trim() || '{}') as { fire?: boolean; message?: string; state?: unknown };
      return parsed.fire === true
        ? { status: 'fire', message: parsed.message, state: parsed.state }
        : { status: 'declined', state: parsed.state };
    } catch (err) {
      // Fail closed on firing, but loudly: this is an error, not a decline.
      return { status: 'error', error: (err as Error).message };
    }
  }

  private async executePayload(job: Job, triggerMessage?: string): Promise<PayloadResult> {
    const context = this.assembleContext(job);

    try {
      switch (job.payload.kind) {
        case 'notify': {
          const text = [context, triggerMessage, job.payload.text].filter(Boolean).join('\n\n');
          return { status: 'ok', output: text, error: null };
        }

        case 'script': {
          const out = await runCommand(
            job.payload.command, job.payload.timeout_s, job.payload.max_output_bytes, {},
          );
          return { status: 'ok', output: out, error: null };
        }

        case 'agent_turn': {
          const message = [context, triggerMessage, job.payload.message].filter(Boolean).join('\n\n');
          const agent = this.agents.get(job.payload.agent_id);
          const res = await withTimeout(
            agent.onMessage({
              message,
              // Reusing one conversation lets the agent say "you missed
              // yesterday too". Assigned on the first run and kept after.
              ...(job.payload.conversation_id !== null ? { conversation_id: job.payload.conversation_id } : {}),
              caller_label: `scheduler:${job.id}`,
            }),
            AGENT_TURN_TIMEOUT_MS,
            'agent turn',
          );
          if (job.payload.conversation_id === null) {
            this.store.setConversationId(job.id, res.conversation_id);
          }
          return { status: 'ok', output: res.reply, error: null };
        }
      }
    } catch (err) {
      return { status: 'error', output: '', error: (err as Error).message };
    }
  }

  /**
   * Upstream jobs' most recent output, prepended to this job's payload.
   *
   * Fenced: this is command output or fetched data, and it lands in an agent
   * prompt whose reply is delivered to a channel. Every other untrusted ingress
   * in the codebase is fenced the same way.
   */
  private assembleContext(job: Job): string {
    if (job.context_from.length === 0) return '';
    const cutoff = this.now() - CONTEXT_MAX_AGE_MS;
    const parts: string[] = [];
    for (const upstream of job.context_from) {
      const out = this.store.latestOutput(upstream, cutoff);
      if (out) parts.push(fenceUntrusted(`output of job ${upstream}`, out));
      else logger.warn('scheduler.context-missing', { job: job.id, upstream });
    }
    return parts.join('\n\n');
  }

  /** True when at least one target accepted the message. */
  private async deliver(job: Job, text: string): Promise<boolean> {
    const targets = job.delivery.channel_ids.length > 0
      ? job.delivery.channel_ids
      : this.delivery.runningIds();
    if (targets.length === 0) {
      logger.warn('scheduler.no-delivery-target', { job: job.id });
      return false;
    }
    let anyOk = false;
    for (const id of targets) {
      try { await this.delivery.send(id, text); anyOk = true; }
      catch (err) { logger.warn('scheduler.deliver-failed', { job: job.id, channel: id, err: (err as Error).message }); }
    }
    return anyOk;
  }

  private async alertFailure(job: Job, error: string, at: number): Promise<void> {
    const target = job.delivery.failure_channel_id;
    if (target === null) return;
    const last = this.lastAlertAt.get(job.id) ?? 0;
    if (at - last < job.delivery.failure_cooldown_s * 1000) return;
    this.lastAlertAt.set(job.id, at);
    await this.delivery.send(target, `job "${job.name}" failed: ${error}`).catch(err =>
      logger.warn('scheduler.alert-failed', { job: job.id, err: (err as Error).message }));
  }

  private maybeAutoDisable(job: Job): void {
    const state = this.store.state(job.id);
    if (!state || state.consecutive_failures < MAX_CONSECUTIVE_FAILURES) return;
    this.store.disable(job.id, 'consecutive-failures');
    logger.error('scheduler.auto-disabled', { job: job.id, failures: state.consecutive_failures });
  }

  /** Trims run history. Called from the daily maintenance sweep. */
  prune(): void {
    try {
      const removed = this.store.pruneRuns(KEEP_RUNS_PER_JOB);
      if (removed > 0) logger.info('scheduler.runs-pruned', { removed });
    } catch (err) {
      logger.warn('scheduler.prune-failed', { err: (err as Error).message });
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    timer.unref();
    p.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e as Error); });
  });
}

/**
 * Run a shell command with a hard timeout and an output cap.
 *
 * Both limits exist because a scheduled command is unattended: without them a
 * hung process holds a tick slot forever and a chatty one fills the database.
 */
function runCommand(
  command: string,
  timeoutS: number,
  maxBytes: number,
  env: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      // Credentials in the parent environment are not the job's to inherit.
      // The caller's additions go first so they can never override the
      // sanitised PATH and HOME.
      env: { ...env, PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group, so a timeout can kill the whole tree. Killing only
      // the shell left grandchildren running and holding the pipes open, so
      // 'close' never fired and the descriptors leaked once per timeout.
      detached: true,
    });

    let bytes = 0;
    let truncated = false;
    const outDecoder = new StringDecoder('utf8');
    let out = '';
    let err = '';

    child.stdout.on('data', (chunk: Buffer) => {
      if (bytes >= maxBytes) { truncated = true; return; }
      // Trim to the cap rather than admitting a whole chunk past it: a declared
      // 1KB limit was storing 64KB, and that output feeds an agent prompt.
      if (bytes + chunk.length > maxBytes) {
        chunk = chunk.subarray(0, maxBytes - bytes);
        truncated = true;
      }
      bytes += chunk.length;
      // Decoded incrementally: converting each chunk independently corrupted
      // any multi-byte character straddling a chunk boundary.
      out += outDecoder.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (err.length < 8192) err += chunk.toString('utf8');
    });

    let settled = false;
    const finish = (fn: () => void): void => { if (!settled) { settled = true; fn(); } };

    const killTree = (): void => {
      try { if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL'); }
      catch { /* already gone */ }
    };

    const timer = setTimeout(() => {
      killTree();
      finish(() => reject(new Error(`timed out after ${timeoutS}s`)));
    }, timeoutS * 1000);
    timer.unref();

    child.on('error', e => { clearTimeout(timer); finish(() => reject(e)); });
    // 'exit' rather than 'close': an orphaned grandchild can hold the pipes
    // open indefinitely, and waiting on 'close' would hang the job behind it.
    child.on('exit', code => {
      clearTimeout(timer);
      // Also on success: a command that exits cleanly having backgrounded a
      // child leaves it orphaned and holding the pipes — an ordinary watchdog
      // shape, leaking a process and two descriptors per run.
      killTree();
      out += outDecoder.end();
      finish(() => {
        if (code !== 0) {
          const detail = err ? `: ${err.trim().slice(0, 500)}` : '';
          reject(new Error(`exit ${code}${detail}`));
          return;
        }
        resolve(truncated ? out + '\n…truncated' : out);
      });
    });
  });
}
