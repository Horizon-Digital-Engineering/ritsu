import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mapLimit } from '../util/concurrency.js';

const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('mapLimit', () => {
  it('keeps results in input order and never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const delays = [30, 5, 20, 1, 10, 2];
    const out = await mapLimit(delays, 2, async (ms, i) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await tick(ms);
      inFlight--;
      return i;
    });
    assert.deepEqual(out, [0, 1, 2, 3, 4, 5]);
    assert.equal(peak, 2);
  });

  it('stops picking up new items once until() is true; unstarted slots stay undefined', async () => {
    let seen = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 1, async n => { await tick(1); seen++; return n * 10; }, () => seen >= 3);
    assert.deepEqual(out.slice(0, 3), [10, 20, 30]);
    assert.ok(out.slice(3).every(v => v === undefined));
  });

  it('handles an empty list', async () => {
    assert.deepEqual(await mapLimit([], 4, async n => n), []);
  });
});
