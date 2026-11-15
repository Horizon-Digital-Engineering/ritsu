// Speech is captured as raw PCM through an AudioWorklet (no MediaRecorder codecs to decode),
// downsampled here to 16 kHz mono 16-bit WAV, which every speech engine on the server reads as is.
// No browser globals are touched at import time, so Node can import this file for tests.

export const RATE = 16000;

const SPEECH_RMS = 0.03;
const QUIET_RMS = 0.015;

export function voiceProblem() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'Voice needs a web browser.';
  if (!window.isSecureContext) return 'The microphone only works on the https address of the app (or on this machine).';
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser cannot record from the microphone.';
  if (typeof AudioContext === 'undefined' || typeof AudioWorkletNode === 'undefined' || !('audioWorklet' in AudioContext.prototype)) {
    return 'This browser is too old to record here; update it and try again.';
  }
  return null;
}

// One context for the page: iOS lets only a tap start one, and Talk records again without a tap.
let shared = null;

function audio() {
  if (!shared || shared.ctx.state === 'closed') {
    let ctx;
    try {
      ctx = new AudioContext();
    } catch (e) {
      throw new Error(`Audio could not start (${e?.message || e}). Try again.`);
    }
    shared = { ctx, worklet: null, active: 0 };
  }
  return shared;
}

function loadWorklet(a) {
  if (!a.worklet) {
    a.worklet = a.ctx.audioWorklet.addModule(new URL('./voice-worklet.js', import.meta.url).href);
    a.worklet.catch(() => { if (shared === a) a.worklet = null; });
  }
  return a.worklet;
}

async function openMicrophone() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    const name = e?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new Error('The browser blocked the microphone. Allow it for this site in the browser\'s site settings, then try again.');
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new Error('No microphone was found.');
    if (name === 'NotReadableError' || name === 'AbortError') throw new Error('The microphone could not start; another app may be using it.');
    throw new Error(`The microphone could not be opened (${e?.message || e}).`);
  }
}

/** After the microphone opens, WebKit lets a context start without a tap. */
async function running(ctx) {
  if (ctx.state === 'running') return;
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(resolve, 2000); });
  await Promise.race([ctx.resume().catch(() => undefined), late]);
  clearTimeout(timer);
  if (ctx.state !== 'running') throw new Error('The browser held the audio back until a tap. Tap the microphone again.');
}

function stopTracks(stream) {
  for (const t of stream.getTracks()) t.stop();
}

// WebKit restarts an 'interrupted' context when the interruption ends unless script suspended it.
function idle(a) {
  if (a.active === 0 && a.ctx.state !== 'suspended' && a.ctx.state !== 'closed') a.ctx.suspend().catch(() => undefined);
}

/**
 * Call it straight from the tap handler: everything iOS needs a user gesture for (creating/resuming
 * the shared AudioContext) happens before its first await.
 */
export async function startRecording(opts) {
  const problem = voiceProblem();
  if (problem) throw new Error(problem);
  const maxSeconds = Number(opts?.maxSeconds);
  if (!positive(maxSeconds)) throw new Error('startRecording needs maxSeconds above zero.');
  const a = audio();
  const woke = a.ctx.state === 'running' ? Promise.resolve() : a.ctx.resume().catch(() => undefined);
  const loaded = loadWorklet(a);
  loaded.catch(() => undefined);
  let stream;
  try {
    stream = await openMicrophone();
  } catch (e) {
    // Chrome ignores a suspend() issued while this resume is still in flight.
    woke.then(() => idle(a));
    throw e;
  }
  try {
    await running(a.ctx);
    try {
      await loaded;
    } catch (e) {
      throw new Error(`The recorder could not load (${e?.message || e}). Reload the page and try again.`);
    }
    return capture(a, stream, opts, maxSeconds);
  } catch (e) {
    stopTracks(stream);
    idle(a);
    throw e;
  }
}

function positive(x) {
  return Number.isFinite(x) && x > 0;
}

function rmsOf(frame) {
  let sum = 0;
  for (const v of frame) sum += v * v;
  return Math.sqrt(sum / frame.length);
}

function pauseDetector(rate, pauseMs) {
  let speech = false;
  let quietSince = null;
  let heard = 0;
  return (rms, frames) => {
    heard += frames;
    const now = (heard / rate) * 1000;
    if (rms > SPEECH_RMS) {
      speech = true;
      quietSince = null;
      return false;
    }
    if (!speech || rms >= QUIET_RMS) return false;
    quietSince ??= now;
    return now - quietSince > pauseMs;
  };
}

function batchFor(rate) {
  return Math.max(128, Math.round(rate / 20 / 128) * 128);
}

function capture(a, stream, opts, maxSeconds) {
  const { ctx } = a;
  const rate = ctx.sampleRate;
  let source;
  let node;
  try {
    source = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, 'ritsu-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { batch: batchFor(rate) },
    });
  } catch (e) {
    source?.disconnect();
    throw new Error(`Recording could not start in this browser (${e?.message || e}).`);
  }
  // The worklet only runs when its output reaches the destination; the gain keeps it silent.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);
  a.active++;

  const pauseMs = Number(opts.pauseMs) >= 0 ? Number(opts.pauseMs) : 1500;
  const cap = Math.max(1, Math.round(maxSeconds * rate));
  const resampler = createDownsampler(rate, RATE);
  const quiet = pauseDetector(rate, pauseMs);
  const parts = [];
  let kept = 0;
  let level = 0;
  let paused = false;
  let limited = false;
  let state = 'recording';
  let released = false;
  let ended = null;
  let result = null;

  const take = (frame) => {
    if (frame.length === 0) return;
    const rms = rmsOf(frame);
    level = Math.min(1, rms * 8);
    if (kept < cap) {
      const n = Math.min(frame.length, cap - kept);
      const out = resampler.push(n === frame.length ? frame : frame.subarray(0, n));
      if (out.length) parts.push(out);
      kept += n;
    }
    const pause = quiet(rms, frame.length) && !paused && Boolean(opts.onPause);
    const limit = !limited && kept >= cap;
    if (state !== 'recording') return;
    if (pause) paused = true;
    if (limit) limited = true;
    if (pause) opts.onPause();
    if (limit) opts.onLimit?.();
  };

  node.port.onmessage = (e) => {
    if (e.data === 'ended') ended?.();
    else if (e.data instanceof Float32Array) take(e.data);
  };

  // iOS interrupts the context for calls and Siri; while the microphone is open it may restart without a tap.
  const onState = () => {
    if (!released && (ctx.state === 'suspended' || ctx.state === 'interrupted')) ctx.resume().catch(() => undefined);
  };
  ctx.addEventListener('statechange', onState);

  // Stopping the tracks is what lets iOS route speech back to the loudspeaker.
  const release = () => {
    if (released) return;
    released = true;
    level = 0;
    node.port.onmessage = null;
    ctx.removeEventListener('statechange', onState);
    source.disconnect();
    node.disconnect();
    mute.disconnect();
    stopTracks(stream);
    a.active--;
    idle(a);
    ended?.();
  };

  return {
    level: () => level,
    seconds: () => kept / rate,
    cancel() {
      if (state === 'recording') state = 'cancelled';
      node.port.postMessage('end');
      release();
    },
    stop() {
      if (result) return result;
      if (state === 'recording') state = 'stopping';
      result = new Promise((resolve) => {
        if (released) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, 500);
        ended = () => { clearTimeout(timer); resolve(); };
        node.port.postMessage('end');
      }).then(() => {
        release();
        const tail = resampler.flush();
        if (tail.length) parts.push(tail);
        return new Blob([encodeWav(join(parts), RATE)], { type: 'audio/wav' });
      });
      return result;
    },
  };
}

function join(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Float32Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function gcd(x, y) {
  while (y) [x, y] = [y, x % y];
  return x;
}

/** A Blackman-windowed sinc per fractional phase: the low-pass and the resample in one step. */
function design(fromRate, toRate) {
  const ratio = Math.min(fromRate, toRate) / fromRate;
  const cutoff = 0.45 * ratio;
  const half = Math.ceil(27.5 / ratio);
  const width = 2 * half;
  const exact = Number.isInteger(fromRate) && Number.isInteger(toRate) && toRate / gcd(fromRate, toRate) <= 1024;
  const phases = exact ? toRate / gcd(fromRate, toRate) : 1024;
  const table = new Float32Array(phases * width);
  for (let p = 0; p < phases; p++) {
    let sum = 0;
    for (let j = 0; j < width; j++) {
      const d = p / phases + half - 1 - j;
      const x = 2 * cutoff * d;
      const sinc = Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = Math.abs(d) >= half ? 0 : 0.42 + 0.5 * Math.cos((Math.PI * d) / half) + 0.08 * Math.cos((2 * Math.PI * d) / half);
      const v = sinc * w;
      table[p * width + j] = v;
      sum += v;
    }
    for (let j = 0; j < width; j++) table[p * width + j] /= sum;
  }
  return { half, width, phases, exact, step: exact ? gcd(fromRate, toRate) : 0, table };
}

/** Pushing a signal in any pieces gives exactly what downsample() gives for the whole. */
export function createDownsampler(fromRate, toRate = RATE) {
  if (!positive(fromRate) || !positive(toRate)) throw new RangeError('sample rates must be positive numbers');
  if (fromRate === toRate) {
    return { push: (chunk) => Float32Array.from(chunk), flush: () => new Float32Array(0) };
  }
  const { half, width, phases, exact, step, table } = design(fromRate, toRate);
  let buf = new Float32Array(0);
  let base = 0;
  let total = 0;
  let n = 0;

  const at = (k) => buf[Math.min(Math.max(k, 0), total - 1) - base];

  const position = (i) => {
    const num = i * fromRate;
    let i0 = Math.floor(num / toRate);
    let p = exact ? Math.round((num - i0 * toRate) / step) : Math.round(((num - i0 * toRate) / toRate) * phases);
    if (p >= phases) {
      p -= phases;
      i0 += 1;
    }
    return { i0, p };
  };

  const dot = (row, first) => {
    let acc = 0;
    if (first >= base && first + width <= total) {
      const off = first - base;
      for (let j = 0; j < width; j++) acc += table[row + j] * buf[off + j];
    } else {
      for (let j = 0; j < width; j++) acc += table[row + j] * at(first + j);
    }
    return acc;
  };

  const run = (count, last) => {
    const out = new Float32Array(Math.max(0, count));
    let made = 0;
    while (made < count) {
      const { i0, p } = position(n);
      const first = i0 - half + 1;
      if (!last && first + width > total) break;
      out[made++] = dot(p * width, first);
      n++;
    }
    const keep = Math.max(0, Math.min(position(n).i0 - half + 1, total) - base);
    if (keep > 0) {
      buf = buf.slice(keep);
      base += keep;
    }
    return made === out.length ? out : out.slice(0, made);
  };

  return {
    push(chunk) {
      if (!chunk.length) return new Float32Array(0);
      const next = new Float32Array(buf.length + chunk.length);
      next.set(buf);
      next.set(chunk, buf.length);
      buf = next;
      total += chunk.length;
      return run(Math.ceil(((total - n * (fromRate / toRate)) * toRate) / fromRate) + 1, false);
    },
    flush() {
      if (total === 0) return new Float32Array(0);
      const out = run(Math.round((total * toRate) / fromRate) - n, true);
      buf = new Float32Array(0);
      base = 0;
      total = 0;
      n = 0;
      return out;
    },
  };
}

export function downsample(input, fromRate, toRate = RATE) {
  const d = createDownsampler(fromRate, toRate);
  const head = d.push(input);
  const tail = d.flush();
  return tail.length ? join([head, tail]) : head;
}

/** Mono 16-bit PCM WAV; samples outside -1..1 are clipped. */
export function encodeWav(samples, rate) {
  const bytes = samples.length * 2;
  const view = new DataView(new ArrayBuffer(44 + bytes));
  const ascii = (at, s) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.codePointAt(i)); };
  const hz = Math.round(rate);
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, hz, true);
  view.setUint32(28, hz * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, bytes, true);
  for (let i = 0; i < samples.length; i++) {
    const c = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, c < 0 ? Math.round(c * 0x8000) : Math.round(c * 0x7fff), true);
  }
  return view.buffer;
}

const FENCE = /^(`{3,}|~{3,})/;
const RULE = /^(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,}|=+)$/;
const LINK_DEFINITION = /^\[[^[\]]+\]:\s*\S/;

function tableDelimiter(line) {
  return line !== undefined && line.includes('|') && line.includes('-') && /^[\s|:-]+$/.test(line);
}

function closesAt(lines, from, closes) {
  for (let j = from; j < lines.length; j++) if (closes(lines[j].trim())) return j + 1;
  return lines.length;
}

function skipTo(lines, i) {
  const t = lines[i].trim();
  const fence = FENCE.exec(t);
  if (fence) return closesAt(lines, i + 1, (s) => s.startsWith(fence[1]) && new Set(s).size === 1);
  if (t.startsWith('$$')) return t.length > 3 && t.endsWith('$$') ? i + 1 : closesAt(lines, i + 1, (s) => s.endsWith('$$'));
  if (t.startsWith('|') || (t.includes('|') && tableDelimiter(lines[i + 1]))) {
    let j = i + 1;
    while (j < lines.length && lines[j].includes('|')) j++;
    return j;
  }
  return RULE.test(t) || LINK_DEFINITION.test(t) ? i + 1 : i;
}

function host(url) {
  const m = /^[a-z][\w+.-]*:\/\/(?:[^@/?#\s]*@)?([^/?#:\s]+)/i.exec(url);
  return m ? m[1].replace(/^www\./i, '') : url;
}

function heading(s) {
  if (!/^#{1,6}(?:\s|$)/.test(s)) return s;
  let text = s.replace(/^#+/, '').trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end--;
  if (end === 0 || /\s/.test(text[end - 1])) text = text.slice(0, end);
  return text.trim();
}

/** One pass can join the text around a removed match into a new match. */
function stripAll(s, re) {
  let before;
  do {
    before = s;
    s = s.replace(re, '');
  } while (s !== before);
  return s;
}

function plain(line) {
  const unescaped = line.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, '$1');
  const linked = heading(stripAll(unescaped, /<!--[\s\S]*?--!?>/g).replace(/^(?:>\s?)+/, ''))
    .replace(/^[-*+]\s+(?:\[[ xX]\]\s+)?/, '')
    .replace(/!\[([^[\]]*)\]\([^()]*\)/g, '$1')
    .replace(/\[([^[\]]+)\]\([^()]*\)/g, '$1')
    .replace(/\[([^[\]]+)\]\[[^[\]]*\]/g, '$1')
    .replace(/\[\^[^[\]]+\]/g, '')
    .replace(/<([a-z][\w+.-]*:\/\/[^<>\s]+)>/gi, (_m, url) => host(url))
    .replace(/\bhttps?:\/\/[^\s<>()]+/gi, (url) => host(url));
  return stripAll(linked, /<\/?[a-z][^<>]*>/gi)
    .replace(/`+/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*(\S[^*]*)\*/g, '$1')
    .replace(/(^|\W)__([^_]+)__(?=\W|$)/g, '$1$2')
    .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Markdown as plain lines worth hearing: no code, tables, link addresses or marks. */
export function speakable(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const next = skipTo(lines, i);
    if (next > i) {
      i = next;
    } else {
      out.push(plain(lines[i].trim()));
      i++;
    }
  }
  return out.join('\n').replace(/\n{2,}/g, '\n').trim();
}

/** Effect voices that ship on Apple devices; they read an answer as a joke. */
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Good News|Hysterical|Jester|Organ|Pipe Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox)\b/i;

let current = null;
let warmed = false;

function hasSpeech() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function';
}

// Some browsers load their voices only after the first getVoices() call.
function warmVoices() {
  if (warmed) return;
  warmed = true;
  try {
    window.speechSynthesis.getVoices();
  } catch {
    warmed = false;
  }
}

function pickVoice() {
  let voices;
  try {
    voices = window.speechSynthesis.getVoices().filter((v) => !NOVELTY.test(v.name));
  } catch {
    return null;
  }
  const lang = (navigator.language || 'en-US').toLowerCase();
  const norm = (v) => String(v.lang || '').toLowerCase().replace('_', '-');
  const fits = (v) => norm(v).slice(0, 2) === lang.slice(0, 2);
  return voices.find((v) => v.default && fits(v))
    ?? voices.find((v) => v.localService && norm(v) === lang)
    ?? voices.find((v) => v.localService && fits(v))
    ?? voices.find(fits)
    ?? null;
}

const SENTENCE_END = /[.!?…]+["')\]”’»]*(?=\s|$)/g;

function pieces(sentence, out) {
  let rest = sentence.trim();
  while (rest.length > 220) {
    const head = rest.slice(0, 220);
    let cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '), head.lastIndexOf(' — '), head.lastIndexOf(' – '));
    if (cut < 80) cut = head.lastIndexOf(' ');
    if (cut < 80) cut = 219;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (/[\p{L}\p{N}]/u.test(rest)) out.push(rest);
}

function sentences(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    let start = 0;
    for (const m of line.matchAll(SENTENCE_END)) {
      const end = m.index + m[0].length;
      // "1." of a numbered step stays with its step
      if (/^\s*\d+[.)]?$/.test(line.slice(start, end))) continue;
      pieces(line.slice(start, end), out);
      start = end;
    }
    pieces(line.slice(start), out);
  }
  return out;
}

export function canSpeak() {
  if (!hasSpeech()) return false;
  warmVoices();
  return true;
}

/** Call inside the tap that starts Talk: iOS speaks later only if one utterance started from a tap. */
export function primeSpeech() {
  if (!hasSpeech()) return;
  warmVoices();
  const synth = window.speechSynthesis;
  try {
    if (synth.paused) synth.resume();
    if (synth.speaking || synth.pending) return;
    const u = new SpeechSynthesisUtterance('');
    u.volume = 0;
    synth.speak(u);
  } catch {
    // speech output is optional; the recording side does not depend on it
  }
}

function finish(s) {
  if (s.done) return;
  s.done = true;
  clearTimeout(s.timer);
  s.u = null;
  if (current === s) current = null;
  if (s.onEnd) queueMicrotask(s.onEnd);
}

// Browsers drop 'end' now and then (an utterance collected early, a stalled engine); this keeps the
// sequence moving without cutting a slow voice short.
function watch(s, u, chars) {
  const allow = 6000 + chars * 150;
  let extended = false;
  const check = () => {
    if (s.u !== u) return;
    const synth = window.speechSynthesis;
    if (synth.speaking && !extended) {
      extended = true;
      s.timer = setTimeout(check, allow);
    } else if (synth.speaking) {
      synth.cancel();
      finish(s);
    } else {
      next(s);
    }
  };
  s.timer = setTimeout(check, allow);
}

const FATAL = new Set(['canceled', 'interrupted', 'not-allowed', 'audio-busy', 'audio-hardware', 'network', 'synthesis-unavailable']);

// WebKit never finishes an utterance that starts inside the previous one's end event (queued
// ones too), so the next sentence always waits for a fresh task.
function later(s, ms) {
  clearTimeout(s.timer);
  s.u = null;
  s.timer = setTimeout(() => next(s), ms);
}

function next(s) {
  if (current !== s || s.done) return;
  clearTimeout(s.timer);
  if (s.at >= s.parts.length) {
    finish(s);
    return;
  }
  const text = s.parts[s.at++];
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = s.voice?.lang || navigator.language || 'en-US';
    if (s.voice) u.voice = s.voice;
    u.onend = () => { if (s.u === u) later(s, 0); };
    u.onerror = (e) => {
      if (s.u !== u) return;
      if (FATAL.has(e?.error)) finish(s);
      else later(s, 0);
    };
    // Held here because Chrome stops sending events for an utterance nothing references.
    s.u = u;
    window.speechSynthesis.speak(u);
    watch(s, u, text.length);
  } catch {
    finish(s);
  }
}

/** A sentence at a time, as browsers cut long utterances short. onEnd always fires once, async. */
export function speak(text, onEnd) {
  const before = current;
  current = null;
  if (before) finish(before);
  const parts = sentences(text);
  if (!hasSpeech() || parts.length === 0) {
    if (onEnd) queueMicrotask(onEnd);
    return;
  }
  warmVoices();
  const s = { parts, at: 0, onEnd, voice: pickVoice(), u: null, timer: 0, done: false };
  current = s;
  const synth = window.speechSynthesis;
  let busy = false;
  try {
    busy = synth.speaking || synth.pending;
    if (busy) synth.cancel();
    if (synth.paused) synth.resume();
  } catch {
    busy = false;
  }
  // Chrome can drop an utterance queued in the same tick as cancel().
  if (busy) later(s, 80);
  else next(s);
}

export function stopSpeaking() {
  const s = current;
  current = null;
  if (hasSpeech()) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // nothing is speaking
    }
  }
  if (s) finish(s);
}

export function speaking() {
  return current !== null;
}
