/**
 * Pure analysis over observation time-series: trends and cross-series
 * correlation. Deterministic + unit-testable — no DB, no clock. Surfaces
 * patterns ("LDL fell after you started X"); it does not interpret or advise.
 */
import type { Observation } from './store.js';

export interface Trend {
  label: string;
  unit: string;
  count: number;
  first: { date: string; value: number } | null;
  last: { date: string; value: number } | null;
  change: number | null;      // last - first
  pctChange: number | null;   // vs first, %
  min: number;
  max: number;
  avg: number;
}

/** `series` must be a single label's observations, oldest→newest. */
export function trend(series: Observation[]): Trend {
  if (series.length === 0) {
    return { label: '', unit: '', count: 0, first: null, last: null, change: null, pctChange: null, min: 0, max: 0, avg: 0 };
  }
  const values = series.map(o => o.value);
  const first = series[0];
  const last = series[series.length - 1];
  const change = last.value - first.value;
  return {
    label: first.label,
    unit: first.unit,
    count: series.length,
    first: { date: first.date, value: first.value },
    last: { date: last.date, value: last.value },
    change,
    pctChange: first.value !== 0 ? (change / Math.abs(first.value)) * 100 : null,
    min: Math.min(...values),
    max: Math.max(...values),
    avg: values.reduce((a, b) => a + b, 0) / values.length,
  };
}

export interface Correlation {
  n: number;                 // paired points used
  r: number | null;          // Pearson, null if too few points or no variance
  windowDays: number;
}

const dayGap = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

/** Pair each observation in B with the NEAREST observation in A within
 *  `windowDays` — so a sparse series (quarterly labs) still pairs against a
 *  dense one (weekly weight). */
function pairByNearest(a: Observation[], b: Observation[], windowDays: number): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (const bo of b) {
    let best: Observation | null = null;
    let bestGap = Infinity;
    for (const ao of a) {
      const g = dayGap(ao.date, bo.date);
      if (g < bestGap) { bestGap = g; best = ao; }
    }
    if (best && bestGap <= windowDays) pairs.push([best.value, bo.value]);
  }
  return pairs;
}

function pearson(pairs: Array<[number, number]>): number | null {
  const n = pairs.length;
  if (n < 3) return null;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pairs) { sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; }
  const num = n * sxy - sx * sy;
  const dx = Math.sqrt(n * sxx - sx * sx);
  const dy = Math.sqrt(n * syy - sy * sy);
  if (dx === 0 || dy === 0) return null;
  return num / (dx * dy);
}

export function correlate(seriesA: Observation[], seriesB: Observation[], windowDays = 14): Correlation {
  const pairs = pairByNearest(seriesA, seriesB, windowDays);
  return { n: pairs.length, r: pearson(pairs), windowDays };
}
