import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { nextRun, catchUp, parseDuration, parseCron } from '../scheduler/schedule.js';
import type { Schedule } from '../scheduler/types.js';

const S = (kind: Schedule['kind'], spec: string, tz: string | null = null, stagger_ms = 0): Schedule =>
  ({ kind, spec, tz, stagger_ms });

const iso = (n: number | null): string => (n === null ? 'null' : new Date(n).toISOString());

/** A Wednesday, 14:30:00Z. Fixed so weekday and offset assertions stay meaningful. */
const BASE = Date.parse('2026-08-05T14:30:00Z');

/** Fire a schedule repeatedly the way the runner does, feeding back the last run. */
function simulate(schedule: Schedule, start: number, count: number): string[] {
  const out: string[] = [];
  let last: number | null = null;
  let from = start;
  for (let i = 0; i < count; i++) {
    const next = nextRun(schedule, from, last);
    if (next === null) break;
    out.push(iso(next));
    last = next;
    from = next;
  }
  return out;
}

describe('scheduler/schedule', () => {
  describe('one-shots terminate', () => {
    it('a relative "at" does not re-arm after it has run', () => {
      // The whole point: "remind me in 2 hours" must not become a permanent
      // every-two-hours alarm.
      const s = S('at', '2h');
      const first = nextRun(s, BASE, null);
      assert.equal(iso(first), '2026-08-05T16:30:00.000Z');
      assert.equal(nextRun(s, first!, first), null);
    });

    it('fires exactly once when driven repeatedly', () => {
      assert.deepEqual(simulate(S('at', '20m'), BASE, 5), ['2026-08-05T14:50:00.000Z']);
    });

    it('an absolute "at" also stops', () => {
      const s = S('at', '2026-08-06T09:00:00Z');
      const first = nextRun(s, BASE, null);
      assert.equal(iso(first), '2026-08-06T09:00:00.000Z');
      assert.equal(nextRun(s, first!, first), null);
    });

    it('is dropped on catch-up rather than fired late', () => {
      assert.equal(catchUp(S('at', '2026-08-06T09:00:00Z'), BASE), null);
    });
  });

  describe('"at" respects the job timezone', () => {
    it('interprets a zone-less timestamp in the job zone, not the host', () => {
      // 08:00 in Los Angeles on Christmas is 16:00Z (PST, UTC-8).
      const got = nextRun(S('at', '2026-12-25T08:00:00', 'America/Los_Angeles'), BASE, null);
      assert.equal(iso(got), '2026-12-25T16:00:00.000Z');
    });

    it('honours an explicit offset over the job zone', () => {
      const got = nextRun(S('at', '2026-12-25T08:00:00Z', 'America/Los_Angeles'), BASE, null);
      assert.equal(iso(got), '2026-12-25T08:00:00.000Z');
    });
  });

  describe('"every" holds its cadence', () => {
    it('anchors on the previous run, so tick latency does not accumulate', () => {
      const s = S('every', '1h');
      let last = Date.parse('2026-08-05T12:00:00Z');
      for (let i = 0; i < 24; i++) {
        // The runner notices each slot 37s late; that lateness must not persist.
        const noticed = last + 37_000;
        const next = nextRun(s, noticed, last)!;
        last = next;
      }
      assert.equal(iso(last), '2026-08-06T12:00:00.000Z', 'should be exactly 24h on, not drifted');
    });

    it('does not compound stagger across runs', () => {
      const s = S('every', '1h', null, 30_000);
      const runs = simulate(s, Date.parse('2026-08-05T12:00:00Z'), 5);
      // Each slot is one hour apart plus a constant 30s, never 30s more each time.
      assert.deepEqual(runs, [
        '2026-08-05T13:00:30.000Z',
        '2026-08-05T14:00:30.000Z',
        '2026-08-05T15:00:30.000Z',
        '2026-08-05T16:00:30.000Z',
        '2026-08-05T17:00:30.000Z',
      ]);
    });

    it('skips ahead after downtime rather than firing once per missed slot', () => {
      const last = Date.parse('2026-08-05T12:00:00Z');
      const backUp = Date.parse('2026-08-05T18:20:00Z');
      const next = nextRun(S('every', '1h'), backUp, last);
      assert.equal(iso(next), '2026-08-05T19:00:00.000Z');
    });

    it('refuses sub-minute intervals the tick could never honour', () => {
      assert.throws(() => nextRun(S('every', '30s'), BASE), /below one minute/);
    });
  });

  describe('daylight saving', () => {
    it('does not fire twice when the hour repeats', () => {
      // 2026-11-01, America/New_York: 01:30 local happens at 05:30Z (EDT) and
      // again at 06:30Z (EST). A daily 01:30 job must fire once that day.
      const s = S('cron', '30 1 * * *', 'America/New_York');
      const runs = simulate(s, Date.parse('2026-10-31T00:00:00Z'), 4);
      const onTransitionDay = runs.filter(r => r.startsWith('2026-11-01'));
      assert.equal(onTransitionDay.length, 1, `fired ${onTransitionDay.length} times: ${runs.join(', ')}`);
    });

    it('does not skip a day when the hour does not exist', () => {
      // 2027-03-14, America/New_York: local jumps 01:59 -> 03:00, so 02:30
      // never occurs. The job must still run that day.
      const s = S('cron', '30 2 * * *', 'America/New_York');
      const runs = simulate(s, Date.parse('2027-03-12T12:00:00Z'), 4);
      const days = runs.map(r => r.slice(0, 10));
      assert.ok(
        days.some(d => d === '2027-03-14') || runs.some(r => r.startsWith('2027-03-14')),
        `no run on the spring-forward day: ${runs.join(', ')}`,
      );
    });

    it('keeps a midnight job on a zone whose transition is at midnight', () => {
      // America/Santiago springs forward at 00:00, so 2026-09-06 has no 00:00
      // local. The job must still run that day rather than silently skipping —
      // the previous assertion here only checked the count and passed while the
      // day was being dropped.
      const s = S('cron', '0 0 * * *', 'America/Santiago');
      const runs = simulate(s, Date.parse('2026-09-04T00:00:00Z'), 5);
      const local = (t: string): string => new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(t));
      const days = new Set(runs.map(local));
      assert.ok(days.has('2026-09-06'), `no run on the transition day: ${runs.join(', ')}`);
      assert.equal(runs.length, new Set(runs).size, 'no duplicate fires');
    });
  });

  describe('cron parsing', () => {
    it('rejects a numeric step prefix rather than silently misreading it', () => {
      // `0/15` is a common spelling of `*/15`, and reading it as the literal {0}
      // fires hourly with no error. Refusing it outright is the safer behaviour.
      assert.throws(() => parseCron('0/15 * * * *'), /stepping with numeric prefix/);
    });

    it('ORs day-of-month with any restricted day-of-week, including "*/1"', () => {
      // A cron gotcha worth pinning: `*/1` is textually not `*`, so it counts as
      // a day-of-week restriction and triggers the OR — "the 1st OR any day",
      // which is every day. Matches vixie.
      const runs = simulate(S('cron', '0 0 1 * */1', 'UTC'), Date.parse('2026-08-05T00:00:00Z'), 2);
      assert.deepEqual(runs, ['2026-08-06T00:00:00.000Z', '2026-08-07T00:00:00.000Z']);
    });

    it('ORs day-of-month with day-of-week when both restrict', () => {
      assert.equal(iso(nextRun(S('cron', '0 0 1 * 1', 'UTC'), BASE)), '2026-08-10T00:00:00.000Z');
    });

    it('treats 7 as Sunday', () => {
      assert.equal(iso(nextRun(S('cron', '0 0 * * 7', 'UTC'), BASE)), '2026-08-09T00:00:00.000Z');
    });

    it('reaches a leap day from any point in the cycle', () => {
      // A one-year scan window rejected this in three years out of four.
      assert.equal(iso(nextRun(S('cron', '0 0 29 2 *', 'UTC'), BASE)), '2028-02-29T00:00:00.000Z');
    });

    it('rejects malformed expressions at parse time', () => {
      assert.throws(() => parseCron('0 9 * *'), /five, six, or seven/);
      assert.throws(() => parseCron('99 9 * * *'), /out of range|Invalid/i);
      // Six fields is a seconds-first expression, and valid.
      assert.doesNotThrow(() => parseCron('0 0 9 * * *'));
    });
  });

  describe('guards', () => {
    it('reports an impossible schedule quickly instead of blocking the event loop', () => {
      // Feb 30 never matches. The scan is synchronous, so spinning here stalls
      // every channel and HTTP handler in the process — it must skip whole
      // non-matching days rather than stepping a minute at a time.
      const started = Date.now();
      assert.equal(nextRun(S('cron', '0 0 30 2 *', 'UTC'), BASE), null);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 500, `scan took ${elapsed}ms; it must not stall the loop`);
    });

    it('rejects an absurd duration instead of scheduling past the heat death', () => {
      assert.throws(() => parseDuration('99999999999999d'), /out of range/);
    });

    it('parses each duration unit', () => {
      assert.equal(parseDuration('500ms'), 500);
      assert.equal(parseDuration('30s'), 30_000);
      assert.equal(parseDuration('2h'), 7_200_000);
      assert.equal(parseDuration('1d'), 86_400_000);
      assert.equal(parseDuration('2026-08-05T00:00:00Z'), null);
    });
  });
});
