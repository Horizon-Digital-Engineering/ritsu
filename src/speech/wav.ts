/** No 30 ms stretch louder than this (-40 dBFS) counts as silence; Whisper invents words over silence. */
const SILENCE_RMS = 0.01;
const WINDOW_MS = 30;
const MIN_RATE = 8_000;
const MAX_RATE = 384_000;
export const WHISPER_RATE = 16_000;

export interface Wav {
  rate: number;
  channels: number;
  seconds: number;
  silent: boolean;
  data: Buffer;
}

export function readWav(b: Buffer): Wav | null {
  if (b.length < 12 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null;
  let fmt: Buffer | null = null;
  let data: Buffer | null = null;
  let at = 12;
  while (at + 8 <= b.length) {
    const id = b.toString('ascii', at, at + 4);
    const len = b.readUInt32LE(at + 4);
    const start = at + 8;
    // A streaming writer may leave the length at its maximum; take what arrived.
    const end = Math.min(start + len, b.length);
    if (id === 'fmt ' && end - start >= 16) fmt = b.subarray(start, end);
    else if (id === 'data') data = b.subarray(start, end);
    at = start + len + (len % 2);
  }
  if (!fmt || !data) return null;
  const format = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2);
  const rate = fmt.readUInt32LE(4);
  const bits = fmt.readUInt16LE(14);
  if (format !== 1 || bits !== 16 || channels < 1 || rate < MIN_RATE || rate > MAX_RATE) return null;
  const frame = 2 * channels;
  const frames = Math.floor(data.length / frame);
  const samples = data.subarray(0, frames * frame);
  return { rate, channels, seconds: frames / rate, silent: loudestWindow(samples, rate, channels) < SILENCE_RMS, data: samples };
}

function loudestWindow(data: Buffer, rate: number, channels: number): number {
  const perWindow = Math.max(1, Math.floor((rate * WINDOW_MS) / 1000)) * channels;
  const total = data.length / 2;
  let loudest = 0;
  for (let from = 0; from < total; from += perWindow) {
    const to = Math.min(total, from + perWindow);
    let sum = 0;
    for (let i = from; i < to; i++) {
      const s = data.readInt16LE(i * 2) / 32768;
      sum += s * s;
    }
    loudest = Math.max(loudest, Math.sqrt(sum / (to - from)));
  }
  return loudest;
}

/** Whisper reads one channel at 16 kHz in [-1, 1). */
export function whisperSamples(wav: Wav): Float32Array {
  const frames = wav.data.length / (2 * wav.channels);
  const mono = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < wav.channels; c++) sum += wav.data.readInt16LE((f * wav.channels + c) * 2);
    mono[f] = sum / wav.channels / 32768;
  }
  return wav.rate === WHISPER_RATE ? mono : resample(mono, wav.rate, WHISPER_RATE);
}

const LOBES = 8;
const STEPS = 512;
let kernelTable: Float32Array | null = null;

function kernel(): Float32Array {
  if (kernelTable) return kernelTable;
  const t = new Float32Array(LOBES * STEPS + 2);
  for (let k = 0; k < t.length; k++) {
    const u = k / STEPS;
    if (u >= LOBES) continue;
    const sinc = u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
    t[k] = sinc * (0.5 + 0.5 * Math.cos((Math.PI * u) / LOBES));
  }
  kernelTable = t;
  return t;
}

/** Band-limited: a windowed-sinc low-pass at the lower of the two Nyquist frequencies. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input.slice();
  const table = kernel();
  const step = from / to;
  const cutoff = Math.min(1, to / from);
  const half = LOBES / cutoff;
  const out = new Float32Array(Math.floor(input.length / step));
  for (let i = 0; i < out.length; i++) {
    const center = i * step;
    const first = Math.max(0, Math.ceil(center - half));
    const last = Math.min(input.length - 1, Math.floor(center + half));
    let acc = 0;
    let norm = 0;
    for (let j = first; j <= last; j++) {
      const pos = Math.abs(j - center) * cutoff * STEPS;
      const k = Math.floor(pos);
      const w = table[k] + (table[k + 1] - table[k]) * (pos - k);
      acc += input[j] * w;
      norm += w;
    }
    // Dividing by the weights keeps unity gain, edges included.
    out[i] = norm > 0 ? acc / norm : 0;
  }
  return out;
}
