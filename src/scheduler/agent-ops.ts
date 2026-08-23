/**
 * Scheduling operations available to an agent, independent of how they are
 * exposed. The native tool loop and the in-process MCP server both call these,
 * so the two surfaces cannot drift — and the ownership rules only have to be
 * right once.
 *
 * Every operation returns a human-readable string: these are tool results read
 * by a model, not an API.
 */
import { nextRun } from './schedule.js';
import type { JobStore } from './store.js';
import type { Schedule } from './types.js';

export interface CreateInput {
  id: string;
  name: string;
  kind: Schedule['kind'];
  spec: string;
  tz?: string | null;
  payload: 'notify' | 'agent_turn';
  message: string;
  channel_ids?: number[];
}

/** Jobs an agent created carry this owner; nothing else may be touched by it. */
const ownerFor = (agentId: string): string => `agent:${agentId}`;

function describe(store: JobStore, id: string): string {
  const job = store.read(id);
  if (!job) return `${id} (missing)`;
  const state = store.state(id);
  const next = state?.next_run_at ? new Date(state.next_run_at).toISOString() : 'not scheduled';
  // The stop reason is the whole point of showing state: a job with no next run
  // may have finished, been paused, or been given up on, and those need
  // different responses.
  const stopped = state?.disabled_reason ? ` [stopped: ${state.disabled_reason}]` : '';
  const failures = state && state.consecutive_failures > 0
    ? ` (${state.consecutive_failures} consecutive failures)` : '';
  return `${job.id} — ${job.name} — ${job.schedule.kind} "${job.schedule.spec}" — next ${next}${stopped}${failures}`;
}

export function createJob(store: JobStore, agentId: string, input: CreateInput): string {
  try {
    // Checked before writing: upsert overwrites every column including the
    // owner, so without this an agent could claim someone else's job and then
    // legitimately delete it, making the checks on remove and pause useless.
    const existing = store.read(input.id);
    if (existing && existing.owner !== ownerFor(agentId)) {
      return `Refused: "${input.id}" already exists and is not yours. Pick a different id.`;
    }

    const schedule: Schedule = {
      kind: input.kind, spec: input.spec, tz: input.tz ?? null, stagger_ms: 0,
    };
    // Validated before storing. A schedule that can never fire would otherwise
    // sit in the table looking scheduled, which is far harder to notice than a
    // rejected call.
    const first = nextRun(schedule, Date.now(), null);
    if (first === null) {
      return `Refused: that schedule will never fire. Check the spec: "${input.spec}".`;
    }

    store.upsert({
      id: input.id,
      name: input.name,
      schedule,
      // Deliberately no `script` payload: arbitrary commands on a timer is a
      // blast radius an agent should not be able to open. An operator still can.
      payload: input.payload === 'notify'
        ? { kind: 'notify', text: input.message }
        : { kind: 'agent_turn', agent_id: agentId, message: input.message, conversation_id: null },
      delivery: { channel_ids: input.channel_ids ?? [] },
      owner: ownerFor(agentId),
    });
    // upsert does not arm a job — only the caller knows the clock — and an
    // unarmed job is invisible to the runner.
    store.setNextRun(input.id, first);
    return `Scheduled. ${describe(store, input.id)}`;
  } catch (err) {
    return `Could not schedule: ${(err as Error).message}`;
  }
}

export function listJobs(store: JobStore, agentId: string, includeOthers = false): string {
  const all = store.list(true);
  // Defaults to the caller's own. Enumerating every job hands an agent a map of
  // the operator's automation for free.
  const rows = includeOthers ? all : all.filter(j => j.owner === ownerFor(agentId));
  if (rows.length === 0) return 'No scheduled jobs.';
  return rows.map(j => describe(store, j.id)).join('\n');
}

export function removeJob(store: JobStore, agentId: string, id: string): string {
  const job = store.read(id);
  if (!job) return `No job "${id}".`;
  if (job.owner !== ownerFor(agentId)) {
    return `Refused: "${id}" was not created by you. Ask the operator to remove it.`;
  }
  store.delete(id);
  return `Removed "${id}".`;
}

export function pauseJob(store: JobStore, agentId: string, id: string, resume: boolean): string {
  const job = store.read(id);
  if (!job) return `No job "${id}".`;
  if (job.owner !== ownerFor(agentId)) return `Refused: "${id}" was not created by you.`;

  store.setEnabled(id, resume);
  if (!resume) {
    store.setNextRun(id, null);
    return `Paused "${id}".`;
  }
  // Resuming has to re-arm: setEnabled clears the stop reason and the failure
  // streak but cannot know what clock to schedule against, so a job enabled
  // without this is silently inert.
  try {
    const next = nextRun(job.schedule, Date.now(), store.state(id)?.last_run_at ?? null);
    if (next === null) return `"${id}" has already finished and will not run again.`;
    store.setNextRun(id, next);
    return `Resumed. ${describe(store, id)}`;
  } catch (err) {
    return `Resumed but could not reschedule: ${(err as Error).message}`;
  }
}
