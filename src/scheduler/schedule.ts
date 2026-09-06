/**
 * Next-run computation.
 *
 * Cron expressions are delegated to `croner`. Calendar arithmetic across
 * daylight-saving transitions is a solved problem and a bad one to re-solve: a
 * hand-rolled scan here fired twice when an hour repeated, skipped the day
 * entirely in zones whose transition falls at midnight, and could not reach a
 * leap day. Croner has no dependencies, uses the same Intl mechanism, and is
 * tested against those transitions — it is used purely as a calculator here,
 * with `paused: true` so it never starts a timer of its own.
 *
 * `at` and `every` stay local: they are arithmetic on instants, not calendar
 * math, and their subtleties are about *this* scheduler's semantics — a
 * one-shot must stop, and an interval must anchor on the slot it was due
 * rather than the tick that noticed it.
 */
import { Cron } from 'croner';
import type { Schedule } from './types.js';

const MINUTE_MS = 60_000;

const DURATION_RE = /^(\d+)\s*(ms|s|m|h|d)$/i;
const UNIT_MS: Record<string, number> = {
  ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000,
};
/** Ten years. Beyond this a duration is a typo whose job would silently never fire. */
const MAX_DURATION_MS = 10 * 365 * 86_400_000;

/** `30m`, `2h`, `1d`. Returns null when the string isn't a duration. */
export function parseDuration(spec: string): number | null {
  const m = DURATION_RE.exec(spec.trim());
  if (!m) return null;
  const ms = Number(m[1]) * UNIT_MS[m[2].toLowerCase()];
  if (!Number.isFinite(ms) || ms > MAX_DURATION_MS) {
    throw new Error(`duration out of range: ${spec}`);
  }
  return ms;
}

/** Throws on a malformed expression, so a bad schedule is refused at creation. */
export function parseCron(spec: string, tz: string | null = null): Cron {
  return new Cron(spec, { timezone: tz ?? 'UTC', paused: true });
}

/**
 * Next fire time strictly after `from`, or null when the schedule will never
 * fire again.
 *
 * `lastRunAt` is what makes a one-shot terminate and what keeps an interval
 * anchored. Pass the instant the job was last *due*; omit it only when
 * computing a first run.
 */
export function nextRun(schedule: Schedule, from: number, lastRunAt?: number | null): number | null {
  switch (schedule.kind) {
    case 'at': return nextAtRun(schedule, from, lastRunAt);
    case 'every': return nextEveryRun(schedule, from, lastRunAt);
    case 'cron': return nextCronRun(schedule, from);
  }
}

function nextAtRun(schedule: Schedule, from: number, lastRunAt?: number | null): number | null {
  // A one-shot that has run is done. Without this, an `at` with a relative
  // spec re-arms to now-plus-duration on every fire and becomes a permanent
  // alarm — "remind me in two hours", every two hours, forever.
  if (lastRunAt !== null && lastRunAt !== undefined) return null;

  const rel = parseDuration(schedule.spec);
  if (rel !== null) return from + rel + schedule.stagger_ms;

  const at = parseAbsolute(schedule.spec, schedule.tz);
  if (at === null) throw new Error(`unparseable 'at' spec: ${schedule.spec}`);
  return at > from ? at + schedule.stagger_ms : null;
}

function nextEveryRun(schedule: Schedule, from: number, lastRunAt?: number | null): number {
  const ms = parseDuration(schedule.spec);
  if (ms === null) throw new Error(`unparseable 'every' spec: ${schedule.spec}`);
  if (ms < MINUTE_MS) throw new Error(`'every' below one minute: ${schedule.spec}`);

  // Anchor on the previous scheduled slot, not the tick that noticed it.
  // Anchoring on the tick permanently absorbs its latency, so an hourly job
  // drifts by minutes a day. The stagger is removed first: the last run
  // happened at slot+stagger, and re-anchoring on that would add the offset
  // again every cycle, turning jitter into an unbounded phase shift.
  const anchor = lastRunAt !== null && lastRunAt !== undefined
    ? lastRunAt - schedule.stagger_ms
    : from;
  let next = anchor + ms;
  // After downtime, skip ahead rather than firing once per missed slot.
  if (next <= from) next = from + ms - ((from - anchor) % ms);
  return next + schedule.stagger_ms;
}

function nextCronRun(schedule: Schedule, from: number): number | null {
  // Croner is strictly after the given instant, which is the semantics we
  // want: a job due at 09:00 must not re-fire for every tick in that minute.
  const next = parseCron(schedule.spec, schedule.tz).nextRun(new Date(from));
  return next === null ? null : next.getTime() + schedule.stagger_ms;
}

/**
 * ISO timestamps, interpreted in the job's zone when they carry no offset.
 *
 * `Date.parse` reads a zone-less string in the *host's* zone, so the same job
 * fired at a different hour depending on which machine ran it.
 */
function parseAbsolute(spec: string, tz: string | null): number | null {
  const trimmed = spec.trim();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  if (hasZone) {
    const t = Date.parse(trimmed);
    return Number.isNaN(t) ? null : t;
  }
  const naive = Date.parse(`${trimmed}Z`);
  if (Number.isNaN(naive)) return null;
  if (tz === null) return naive;

  // Treat the parsed value as the wall-clock reading wanted in `tz`, then
  // correct by that zone's offset near that instant. Applied twice because the
  // offset itself depends on the instant when close to a transition.
  let guess = naive;
  for (let i = 0; i < 2; i++) guess = naive - offsetAt(guess, tz);
  return guess;
}

/** Offset of `tz` at an instant, in ms east of UTC. */
function offsetAt(at: number, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(at))) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute),
  );
  return Math.round((asUtc - Math.floor(at / MINUTE_MS) * MINUTE_MS) / MINUTE_MS) * MINUTE_MS;
}

/**
 * Next run after a restart, for a job that came due while the process was down.
 *
 * Overdue runs move forward and are never replayed — a week of downtime must
 * not deliver a week of reminders at once.
 *
 * A one-shot gets a grace window rather than being dropped outright. The tick
 * only starts a minute after boot, so anything due in that window would
 * otherwise be destroyed silently on every restart; late is better than never
 * for a reminder, and hours late is not.
 */
const ONE_SHOT_GRACE_MS = 6 * 3_600_000;

export function catchUp(
  schedule: Schedule,
  now: number,
  lastRunAt?: number | null,
  dueAt?: number | null,
): number | null {
  if (schedule.kind === 'at') {
    if (lastRunAt !== null && lastRunAt !== undefined) return null;
    if (dueAt !== null && dueAt !== undefined && now - dueAt < ONE_SHOT_GRACE_MS) return now;
    return null;
  }
  return nextRun(schedule, now, lastRunAt);
}
