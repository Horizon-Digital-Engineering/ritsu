import { describe, it, before, after, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

interface Recording { stop(): Promise<Blob>; cancel(): void; level(): number; seconds(): number }
interface RecordOptions { maxSeconds: number; pauseMs?: number; onPause?: () => void; onLimit?: () => void }
interface Downsampler { push(chunk: Float32Array): Float32Array; flush(): Float32Array }
interface VoiceModule {
  RATE: number;
  voiceProblem(): string | null;
  startRecording(opts: RecordOptions): Promise<Recording>;
  downsample(input: Float32Array, fromRate: number, toRate?: number): Float32Array;
  createDownsampler(fromRate: number, toRate?: number): Downsampler;
  encodeWav(samples: Float32Array, rate: number): ArrayBuffer;
  speakable(markdown: string): string;
  canSpeak(): boolean;
  primeSpeech(): void;
  speak(text: string, onEnd?: () => void): void;
  stopSpeaking(): void;
  speaking(): boolean;
}

// The browser module is plain JS served as is; Node imports the same file.
const voice = (await import(pathToFileURL(resolve('src/admin/voice.js')).href)) as VoiceModule;
const WORKLET = resolve('src/admin/voice-worklet.js');

const tick = () => new Promise<void>((r) => setImmediate(r));
const nextTask = () => new Promise<void>((r) => setTimeout(r, 2));

function tone(freq: number, rate: number, seconds: number, amp = 1): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function rms(a: Float32Array, skip = 0): number {
  let sum = 0;
  for (let i = skip; i < a.length - skip; i++) sum += a[i] * a[i];
  return Math.sqrt(sum / (a.length - 2 * skip));
}

/** Deterministic noise so a failure reproduces. */
function noise(n: number, seed = 7): Float32Array {
  const out = new Float32Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out[i] = x / 2147483648 - 0.5;
  }
  return out;
}

function wavSamples(buf: ArrayBuffer): { view: DataView; count: number } {
  const view = new DataView(buf);
  return { view, count: view.getUint32(40, true) / 2 };
}

function ascii(view: DataView, at: number, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCodePoint(view.getUint8(at + i));
  return s;
}

/** Node defines navigator itself. */
function stubGlobal(name: string, value: unknown): () => void {
  const had = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return () => {
    if (had) Object.defineProperty(globalThis, name, had);
    else Reflect.deleteProperty(globalThis, name);
  };
}

describe('downsample', () => {
  it('keeps the duration for 48000 → 16000 and 44100 → 16000', () => {
    assert.equal(voice.downsample(new Float32Array(48000), 48000).length, 16000);
    assert.equal(voice.downsample(new Float32Array(44100), 44100).length, 16000);
    assert.equal(voice.downsample(new Float32Array(22050), 44100, 16000).length, 8000);
    assert.equal(voice.downsample(new Float32Array(1000), 44100).length, 363);
    assert.equal(voice.downsample(new Float32Array(0), 48000).length, 0);
  });

  it('preserves a DC level at every sample, edges included', () => {
    for (const rate of [48000, 44100]) {
      const out = voice.downsample(new Float32Array(rate / 2).fill(0.25), rate);
      for (const s of out) assert.ok(Math.abs(s - 0.25) < 1e-6, `${rate}: ${s}`);
    }
  });

  it('passes speech-band tones at full level', () => {
    for (const rate of [48000, 44100]) {
      for (const f of [300, 1000, 3000, 6000]) {
        const gain = rms(voice.downsample(tone(f, rate, 1), rate), 200) / rms(tone(f, rate, 1));
        assert.ok(gain > 0.99 && gain < 1.01, `${rate} Hz, ${f} Hz tone: gain ${gain}`);
      }
    }
  });

  it('strongly attenuates tones above the new Nyquist (8 kHz)', () => {
    for (const rate of [48000, 44100]) {
      for (const f of [9000, 10000, 12000, 15000]) {
        const gain = rms(voice.downsample(tone(f, rate, 1), rate), 200) / rms(tone(f, rate, 1));
        assert.ok(gain < 1e-3, `${rate} Hz, ${f} Hz tone leaks at ${(20 * Math.log10(gain)).toFixed(1)} dB`);
      }
    }
  });

  it('streams in any pieces to exactly the one-shot result', () => {
    for (const rate of [48000, 44100]) {
      const input = noise(rate * 2 + 123);
      const whole = voice.downsample(input, rate);
      const d = voice.createDownsampler(rate);
      const sizes = [1, 7, 128, 2432, 2176, 5000, 3];
      const parts: Float32Array[] = [];
      for (let at = 0, k = 0; at < input.length; k++) {
        const n = Math.min(sizes[k % sizes.length], input.length - at);
        parts.push(d.push(input.subarray(at, at + n)));
        at += n;
      }
      parts.push(d.flush());
      const streamed = parts.flatMap((p) => Array.from(p));
      assert.equal(streamed.length, whole.length);
      assert.deepEqual(streamed, Array.from(whole));
    }
  });

  it('copies when the rates already match and rejects nonsense rates', () => {
    const input = noise(100);
    const out = voice.downsample(input, 16000);
    assert.notEqual(out, input);
    assert.deepEqual(Array.from(out), Array.from(input));
    assert.throws(() => voice.downsample(input, 0), RangeError);
    assert.throws(() => voice.downsample(input, Number.NaN), RangeError);
  });
});

describe('encodeWav', () => {
  it('writes every header field of mono 16-bit PCM', () => {
    const buf = voice.encodeWav(new Float32Array(16000), 16000);
    const view = new DataView(buf);
    assert.equal(buf.byteLength, 44 + 32000);
    assert.equal(ascii(view, 0, 4), 'RIFF');
    assert.equal(view.getUint32(4, true), 36 + 32000);
    assert.equal(ascii(view, 8, 4), 'WAVE');
    assert.equal(ascii(view, 12, 4), 'fmt ');
    assert.equal(view.getUint32(16, true), 16);
    assert.equal(view.getUint16(20, true), 1, 'PCM');
    assert.equal(view.getUint16(22, true), 1, 'mono');
    assert.equal(view.getUint32(24, true), 16000, 'sample rate');
    assert.equal(view.getUint32(28, true), 32000, 'byte rate');
    assert.equal(view.getUint16(32, true), 2, 'block align');
    assert.equal(view.getUint16(34, true), 16, 'bits per sample');
    assert.equal(ascii(view, 36, 4), 'data');
    assert.equal(view.getUint32(40, true), 32000);
  });

  it('scales, rounds and clips samples', () => {
    const { view, count } = wavSamples(voice.encodeWav(Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2, Number.NaN]), 16000));
    assert.equal(count, 8);
    const got = Array.from({ length: count }, (_, i) => view.getInt16(44 + i * 2, true));
    assert.deepEqual(got, [0, 16384, -16384, 32767, -32768, 32767, -32768, 0]);
  });

  it('handles an empty recording', () => {
    const buf = voice.encodeWav(new Float32Array(0), 16000);
    assert.equal(buf.byteLength, 44);
    assert.equal(new DataView(buf).getUint32(40, true), 0);
  });
});

describe('speakable', () => {
  it('drops fenced code, with backticks or tildes, and an unclosed fence to the end', () => {
    assert.equal(voice.speakable('Before\n```js\nconst total = 1;\n```\nAfter'), 'Before\nAfter');
    assert.equal(voice.speakable('Before\n~~~\nraw\n~~~\nAfter'), 'Before\nAfter');
    assert.equal(voice.speakable('Before\n````\n```\nstill code\n````\nAfter'), 'Before\nAfter');
    assert.equal(voice.speakable('Before\n```\nnever closed'), 'Before');
  });

  it('drops tables, with or without outer pipes', () => {
    const md = 'Balances:\n\n| Account | Balance |\n|---|---:|\n| Checking | $1,200 |\n\nAccount | Balance\n--- | ---\nSavings | $5\n\nThat is all.';
    assert.equal(voice.speakable(md), 'Balances:\nThat is all.');
  });

  it('reads link text, image alt text and only the host of a bare address', () => {
    assert.equal(voice.speakable('See [the ledger](https://example.test/l?x=1).'), 'See the ledger.');
    assert.equal(voice.speakable('![chart of spending](/img/a.png)'), 'chart of spending');
    assert.equal(voice.speakable('Visit https://www.example.test/docs/page or <https://example.test/x>.'), 'Visit example.test or example.test.');
    assert.equal(voice.speakable('Read [this][ref] first.\n\n[ref]: https://example.test/r'), 'Read this first.');
  });

  it('strips heading, bullet, quote and rule marks', () => {
    assert.equal(voice.speakable('# Title\n## Totals ##\n#hashtag stays'), 'Title\nTotals\n#hashtag stays');
    assert.equal(voice.speakable('- one\n* two\n+ three\n- [x] done\n- [ ] open'), 'one\ntwo\nthree\ndone\nopen');
    assert.equal(voice.speakable('1. Open the app.\n2. Tap Settings.'), '1. Open the app.\n2. Tap Settings.');
    assert.equal(voice.speakable('> quoted\n\n---\n\nafter'), 'quoted\nafter');
  });

  it('strips emphasis without touching snake_case or arithmetic', () => {
    assert.equal(
      voice.speakable('**bold** and *it* and _it_ and __b__ and ~~gone~~ and \\*escaped\\*'),
      'bold and it and it and b and gone and escaped',
    );
    assert.equal(voice.speakable('my_var_name and 5 * 3 = 15'), 'my_var_name and 5 * 3 = 15');
    assert.equal(voice.speakable('_(stopped)_'), '(stopped)');
  });

  it('keeps inline code as words and drops HTML tags', () => {
    assert.equal(voice.speakable('Run `ritsu doctor` now, or ``a `b` c``.'), 'Run ritsu doctor now, or a b c.');
    assert.equal(voice.speakable('A <b>tag</b> and a<br>break'), 'A tag and abreak');
  });

  it('collapses blank lines and trims', () => {
    assert.equal(voice.speakable('\n\nfirst\n\n\n\nsecond\n\n'), 'first\nsecond');
    assert.equal(voice.speakable('a\r\n\r\nb'), 'a\nb');
    assert.equal(voice.speakable(''), '');
  });
});

describe('in Node, with no browser', () => {
  it('voiceProblem gives a reason', () => {
    const why = voice.voiceProblem();
    assert.equal(typeof why, 'string');
    assert.ok(why && why.length > 0);
  });

  it('startRecording rejects with that reason', async () => {
    await assert.rejects(voice.startRecording({ maxSeconds: 5 }), { message: voice.voiceProblem() ?? '' });
  });

  it('speech is unavailable but onEnd still fires exactly once, after speak returns', async () => {
    assert.equal(voice.canSpeak(), false);
    let ended = 0;
    voice.speak('Hello there.', () => { ended++; });
    assert.equal(ended, 0);
    await tick();
    assert.equal(ended, 1);
    assert.equal(voice.speaking(), false);
    voice.primeSpeech();
    voice.stopSpeaking();
    await tick();
    assert.equal(ended, 1);
  });
});

interface FakeVoice { name: string; lang: string; localService: boolean; default: boolean }

class FakeUtterance {
  lang = '';
  voice: FakeVoice | null = null;
  volume = 1;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  constructor(public text: string) {}
}

class FakeSynth {
  voices: FakeVoice[] = [];
  queue: FakeUtterance[] = [];
  spoken: FakeUtterance[] = [];
  speaking = false;
  pending = false;
  paused = false;
  cancels = 0;
  getVoices(): FakeVoice[] { return this.voices; }
  speak(u: FakeUtterance): void {
    this.spoken.push(u);
    this.queue.push(u);
    this.speaking = true;
  }
  cancel(): void {
    this.cancels++;
    const dropped = this.queue;
    this.queue = [];
    this.speaking = false;
    for (const u of dropped) u.onerror?.({ error: 'interrupted' });
  }
  resume(): void { this.paused = false; }
  finishOne(): void {
    const u = this.queue.shift();
    this.speaking = this.queue.length > 0;
    u?.onend?.();
  }
  failOne(error: string): void {
    const u = this.queue.shift();
    this.speaking = this.queue.length > 0;
    u?.onerror?.({ error });
  }
  last(): FakeUtterance | undefined { return this.spoken.at(-1); }
}

describe('speech output with a stand-in engine', () => {
  const synth = new FakeSynth();
  const restore: (() => void)[] = [];
  before(() => {
    restore.push(stubGlobal('window', { isSecureContext: true, speechSynthesis: synth }));
    restore.push(stubGlobal('SpeechSynthesisUtterance', FakeUtterance));
    restore.push(stubGlobal('navigator', { language: 'en-US' }));
  });
  after(() => { for (const r of restore.reverse()) r(); });

  const reset = () => {
    voice.stopSpeaking();
    synth.queue = [];
    synth.spoken = [];
    synth.speaking = false;
    synth.cancels = 0;
  };

  it('reads one sentence at a time and calls onEnd once at the end', async () => {
    reset();
    let ended = 0;
    voice.speak('First one. Second one! Third?', () => { ended++; });
    assert.equal(voice.speaking(), true);
    assert.deepEqual(synth.spoken.map((u) => u.text), ['First one.']);
    synth.finishOne();
    await nextTask();
    synth.finishOne();
    await nextTask();
    assert.deepEqual(synth.spoken.map((u) => u.text), ['First one.', 'Second one!', 'Third?']);
    synth.finishOne();
    assert.equal(voice.speaking(), true, 'still speaking until the last sentence is settled');
    await nextTask();
    assert.equal(voice.speaking(), false);
    assert.equal(ended, 1);
    synth.spoken[0].onend?.();
    await nextTask();
    assert.equal(ended, 1);
    assert.equal(synth.spoken.length, 3);
  });

  it('never starts the next sentence inside the previous end event (WebKit drops it)', async () => {
    reset();
    voice.speak('One. Two.');
    synth.finishOne();
    assert.equal(synth.spoken.length, 1);
    assert.equal(voice.speaking(), true);
    await nextTask();
    assert.equal(synth.last()?.text, 'Two.');
    voice.stopSpeaking();
  });

  it('stopSpeaking cancels and ends it once, ignoring late events', async () => {
    reset();
    let ended = 0;
    voice.speak('One. Two. Three.', () => { ended++; });
    const first = synth.spoken[0];
    voice.stopSpeaking();
    assert.equal(voice.speaking(), false);
    assert.ok(synth.cancels >= 1);
    first.onend?.();
    await tick();
    assert.equal(ended, 1);
    assert.equal(synth.spoken.length, 1);
  });

  it('a new speak replaces the old reading, which still gets its onEnd once', async () => {
    reset();
    const ends: string[] = [];
    voice.speak('Old answer here. More.', () => ends.push('old'));
    voice.speak('New answer.', () => ends.push('new'));
    await tick();
    assert.deepEqual(ends, ['old']);
    // the engine was busy, so the new reading starts a beat after cancel()
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(synth.last()?.text, 'New answer.');
    synth.finishOne();
    await nextTask();
    assert.deepEqual(ends, ['old', 'new']);
  });

  it('skips a sentence the engine could not synthesise but stops on a blocking error', async () => {
    reset();
    let ended = 0;
    voice.speak('Fine. Broken. Last.', () => { ended++; });
    synth.failOne('synthesis-failed');
    await nextTask();
    assert.equal(synth.last()?.text, 'Broken.');
    synth.failOne('not-allowed');
    await tick();
    assert.equal(ended, 1);
    assert.equal(voice.speaking(), false);
    assert.equal(synth.spoken.length, 2);
  });

  it('calls onEnd once when nothing is worth saying', async () => {
    reset();
    let ended = 0;
    voice.speak('', () => { ended++; });
    voice.speak(' — ', () => { ended++; });
    await tick();
    assert.equal(ended, 2);
    assert.equal(synth.spoken.length, 0);
  });

  it('keeps numbered steps and decimals whole and cuts long sentences near a comma', async () => {
    reset();
    const long = Array.from({ length: 12 }, (_, i) => `clause number ${i} goes on for a while`).join(', ') + '.';
    voice.speak(`1. Open the app. The price is 3.5 dollars. ${long}`);
    for (let guard = 0; voice.speaking() && guard < 50; guard++) {
      synth.finishOne();
      await nextTask();
    }
    const unique = synth.spoken.map((u) => u.text);
    assert.equal(unique[0], '1. Open the app.');
    assert.equal(unique[1], 'The price is 3.5 dollars.');
    assert.ok(unique.length > 3, 'the long sentence is split');
    for (const t of unique) assert.ok(t.length <= 220, `${t.length} chars`);
    assert.equal(unique.slice(2).join(' '), long);
  });

  it('prefers the default voice for the language and skips effect voices', () => {
    reset();
    const v = (name: string, lang: string, isDefault = false): FakeVoice => ({ name, lang, localService: true, default: isDefault });
    synth.voices = [v('Albert', 'en-US'), v('Thomas', 'fr-FR', true), v('Fred', 'en-US'), v('Samantha', 'en-US', true)];
    voice.speak('Hello.');
    assert.equal(synth.last()?.voice?.name, 'Samantha');
    reset();
    synth.voices = [v('Albert', 'en-US'), v('Daniel', 'en_GB'), v('Fred', 'en-US')];
    voice.speak('Hello.');
    assert.equal(synth.last()?.voice?.name, 'Fred');
    reset();
    synth.voices = [];
    voice.speak('Hello.');
    assert.equal(synth.last()?.voice, null);
    assert.equal(synth.last()?.lang, 'en-US');
    reset();
  });

  it('primeSpeech queues one silent utterance only when idle', () => {
    reset();
    voice.primeSpeech();
    assert.equal(synth.spoken.length, 1);
    assert.equal(synth.spoken[0].text, '');
    assert.equal(synth.spoken[0].volume, 0);
    voice.primeSpeech();
    assert.equal(synth.spoken.length, 1);
    reset();
  });

  it('a lost end event does not hang the reading', async () => {
    reset();
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let ended = 0;
      voice.speak('Only one.', () => { ended++; });
      synth.queue = [];
      synth.speaking = false;
      mock.timers.tick(60_000);
      await tick();
      assert.equal(ended, 1);
      assert.equal(voice.speaking(), false);
    } finally {
      mock.timers.reset();
    }
  });
});

interface Track { stopped: boolean; stop(): void }
type PortMessage = { data: unknown };

class FakePort {
  onmessage: ((e: PortMessage) => void) | null = null;
  posted: unknown[] = [];
  partial: Float32Array | null = null;
  postMessage(msg: unknown): void {
    this.posted.push(msg);
    if (msg !== 'end') return;
    setTimeout(() => {
      if (this.partial) this.onmessage?.({ data: this.partial });
      this.onmessage?.({ data: 'ended' });
    }, 0);
  }
  frame(samples: Float32Array): void { this.onmessage?.({ data: samples }); }
}

interface NodeOptions { channelCount: number; processorOptions: { batch: number } }

class FakeNode {
  static made: FakeNode[] = [];
  port = new FakePort();
  connected = false;
  constructor(public ctx: FakeContext, public name: string, public options: NodeOptions) { FakeNode.made.push(this); }
  connect(): void { this.connected = true; }
  disconnect(): void { this.connected = false; }
}

class FakeContext {
  static made: FakeContext[] = [];
  state = 'suspended';
  sampleRate = 48000;
  destination = {};
  resumes = 0;
  suspends = 0;
  refuse = false;
  /** Chrome: a resume lands on a later task, and a suspend() issued before then does not stop it. */
  lag = false;
  modules: string[] = [];
  listeners = new Set<() => void>();
  constructor() { FakeContext.made.push(this); }
  get audioWorklet(): { addModule(url: string): Promise<void> } {
    return { addModule: async (url: string) => { this.modules.push(url); } };
  }
  resume(): Promise<void> {
    this.resumes++;
    if (this.refuse) return Promise.reject(new Error('not allowed without a gesture'));
    if (this.lag) {
      return new Promise((done) => {
        setTimeout(() => { this.state = 'running'; done(); }, 1);
      });
    }
    this.state = 'running';
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    this.suspends++;
    this.state = 'suspended';
    return Promise.resolve();
  }
  createMediaStreamSource(): { connect(): void; disconnect(): void } {
    return { connect: () => undefined, disconnect: () => undefined };
  }
  createGain(): { gain: { value: number }; connect(): void; disconnect(): void } {
    return { gain: { value: 1 }, connect: () => undefined, disconnect: () => undefined };
  }
  addEventListener(_type: string, fn: () => void): void { this.listeners.add(fn); }
  removeEventListener(_type: string, fn: () => void): void { this.listeners.delete(fn); }
}

describe('recording with a stand-in audio stack', () => {
  const tracks: Track[] = [];
  let micError: Error | null = null;
  const refusal = (name: string) => Object.assign(new Error(`the microphone said ${name}`), { name });
  const restore: (() => void)[] = [];
  before(() => {
    restore.push(stubGlobal('window', { isSecureContext: true }));
    restore.push(stubGlobal('AudioContext', FakeContext));
    restore.push(stubGlobal('AudioWorkletNode', FakeNode));
    restore.push(stubGlobal('navigator', {
      language: 'en-US',
      mediaDevices: {
        getUserMedia: async () => {
          if (micError) throw micError;
          const track: Track = { stopped: false, stop() { this.stopped = true; } };
          tracks.push(track);
          return { getTracks: () => [track] };
        },
      },
    }));
  });
  after(() => { for (const r of restore.reverse()) r(); });

  const latest = () => FakeNode.made.at(-1) as FakeNode;
  const frames = (port: FakePort, count: number, amp: number, size = 2432) => {
    for (let i = 0; i < count; i++) port.frame(Float32Array.from(tone(440, 48000, size / 48000, amp)));
  };

  it('creates and resumes the context and starts loading the worklet before its first await', async () => {
    assert.equal(voice.voiceProblem(), null);
    const pending = voice.startRecording({ maxSeconds: 5 });
    assert.equal(FakeContext.made.length, 1);
    const ctx = FakeContext.made[0];
    assert.ok(ctx.resumes >= 1, 'resume() called inside the tap');
    assert.equal(ctx.modules.length, 1);
    assert.match(ctx.modules[0], /\/voice-worklet\.js$/);
    const rec = await pending;
    const node = latest();
    assert.equal(node.name, 'ritsu-capture');
    assert.equal(node.options.channelCount, 1);
    assert.equal(node.options.processorOptions.batch, 2432);
    assert.equal(node.connected, true, 'the worklet has a path to the destination');
    rec.cancel();
  });

  it('records 16 kHz WAV and flushes the partial batch on stop', async () => {
    const rec = await voice.startRecording({ maxSeconds: 5 });
    const node = latest();
    const ctx = FakeContext.made[0];
    frames(node.port, 20, 0.3);
    node.port.partial = Float32Array.from(tone(440, 48000, 1000 / 48000, 0.3));
    assert.ok(rec.level() > 0.9);
    const wav = await rec.stop();
    assert.equal(wav.type, 'audio/wav');
    const { view, count } = wavSamples(await wav.arrayBuffer());
    assert.equal(view.getUint32(24, true), 16000);
    assert.equal(count, Math.round((20 * 2432 + 1000) / 3));
    assert.ok(Math.abs(rec.seconds() - (20 * 2432 + 1000) / 48000) < 1e-9);
    assert.ok(node.port.posted.includes('end'));
    assert.equal(tracks.at(-1)?.stopped, true, 'the microphone is released');
    assert.equal(ctx.state, 'suspended', 'the shared context rests between recordings');
    assert.equal(rec.level(), 0);
    assert.equal(await rec.stop(), wav, 'stop() is idempotent');
  });

  it('fires onPause once, only after speech and then pauseMs of quiet', async () => {
    let pauses = 0;
    const rec = await voice.startRecording({ maxSeconds: 30, pauseMs: 300, onPause: () => { pauses++; } });
    const { port } = latest();
    frames(port, 20, 0.001);
    assert.equal(pauses, 0, 'quiet before any speech is not a pause');
    frames(port, 10, 0.2);
    frames(port, 4, 0.028);
    frames(port, 6, 0.001);
    assert.equal(pauses, 0, 'the in-between level neither counts as speech nor as quiet');
    let quietFrames = 6;
    while (pauses === 0 && quietFrames < 40) {
      frames(port, 1, 0.001);
      quietFrames++;
    }
    assert.equal(pauses, 1);
    // first quiet frame starts the clock; the pause needs more than 300 ms after it
    assert.equal(quietFrames, 7);
    frames(port, 20, 0.001);
    assert.equal(pauses, 1);
    rec.cancel();
    assert.equal(tracks.at(-1)?.stopped, true);
  });

  it('fires onLimit once at maxSeconds and keeps no more than that', async () => {
    let limits = 0;
    const rec = await voice.startRecording({ maxSeconds: 0.5, onLimit: () => { limits++; } });
    const { port } = latest();
    frames(port, 9, 0.2);
    assert.equal(limits, 0);
    frames(port, 1, 0.2);
    assert.equal(limits, 1);
    frames(port, 5, 0.2);
    assert.equal(limits, 1);
    assert.equal(rec.seconds(), 0.5);
    const { count } = wavSamples(await (await rec.stop()).arrayBuffer());
    assert.equal(count, 8000);
  });

  it('sends no callbacks once stop() was called', async () => {
    let calls = 0;
    const rec = await voice.startRecording({ maxSeconds: 0.2, pauseMs: 0, onPause: () => { calls++; }, onLimit: () => { calls++; } });
    const node = latest();
    frames(node.port, 2, 0.2);
    const done = rec.stop();
    frames(node.port, 4, 0.001);
    frames(node.port, 4, 0.2);
    await done;
    assert.equal(calls, 0);
  });

  it('reuses one AudioContext, waking it for each recording and on an iOS interruption', async () => {
    const ctx = FakeContext.made[0];
    const before = ctx.resumes;
    const rec = await voice.startRecording({ maxSeconds: 5 });
    assert.equal(FakeContext.made.length, 1);
    assert.ok(ctx.resumes > before);
    ctx.state = 'interrupted';
    for (const fn of ctx.listeners) fn();
    assert.equal(ctx.state, 'running');
    rec.cancel();
    assert.equal(ctx.listeners.size, 0);
  });

  it('asks for another tap when the browser will not start audio, and lets go of the microphone', async () => {
    const ctx = FakeContext.made[0];
    ctx.refuse = true;
    try {
      await assert.rejects(voice.startRecording({ maxSeconds: 5 }), /Tap the microphone again/);
      assert.equal(tracks.at(-1)?.stopped, true);
    } finally {
      ctx.refuse = false;
    }
  });

  it('explains a blocked or missing microphone and lets the context rest again', async () => {
    const ctx = FakeContext.made[0];
    try {
      micError = refusal('NotAllowedError');
      await assert.rejects(voice.startRecording({ maxSeconds: 5 }), /blocked the microphone/);
      await tick();
      assert.equal(ctx.state, 'suspended');
      micError = refusal('NotFoundError');
      await assert.rejects(voice.startRecording({ maxSeconds: 5 }), /No microphone/);
      await tick();
      assert.equal(ctx.state, 'suspended');
      ctx.lag = true;
      micError = refusal('NotReadableError');
      const suspends = ctx.suspends;
      await assert.rejects(voice.startRecording({ maxSeconds: 5 }), /another app/);
      assert.equal(ctx.state, 'suspended', 'the resume from the tap has not landed yet');
      await nextTask();
      assert.equal(ctx.suspends, suspends + 1);
      assert.equal(ctx.state, 'suspended', 'suspended after the resume landed');
    } finally {
      micError = null;
      ctx.lag = false;
    }
  });

  it('suspends a context iOS interrupted when the recording ends, so it does not restart after the interruption', async () => {
    const ctx = FakeContext.made[0];
    const rec = await voice.startRecording({ maxSeconds: 5 });
    const suspends = ctx.suspends;
    ctx.refuse = true;
    try {
      ctx.state = 'interrupted';
      for (const fn of ctx.listeners) fn();
      assert.equal(ctx.state, 'interrupted');
      rec.cancel();
      assert.equal(ctx.suspends, suspends + 1);
      assert.equal(ctx.state, 'suspended');
    } finally {
      ctx.refuse = false;
    }
  });
});

interface StubPort { posted: { msg: unknown; transfer: unknown[] | undefined }[]; onmessage: ((e: PortMessage) => void) | null }
interface CaptureProcessor { port: StubPort; process(inputs: Float32Array[][]): boolean }
type CaptureClass = new (options?: unknown) => CaptureProcessor;

describe('voice-worklet.js', () => {
  it('parses as JavaScript', () => {
    const out = ts.transpileModule(readFileSync(WORKLET, 'utf8'), {
      fileName: 'voice-worklet.js',
      reportDiagnostics: true,
      compilerOptions: { allowJs: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    });
    assert.deepEqual((out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')), []);
  });

  it('batches quanta, transfers each batch, and flushes the rest on end', async () => {
    class StubProcessor {
      port: StubPort & { postMessage(msg: unknown, transfer?: unknown[]): void } = {
        posted: [],
        onmessage: null,
        postMessage(msg: unknown, transfer?: unknown[]) { this.posted.push({ msg, transfer }); },
      };
    }
    const registered = new Map<string, CaptureClass>();
    const restore = [
      stubGlobal('AudioWorkletProcessor', StubProcessor),
      stubGlobal('registerProcessor', (name: string, cls: CaptureClass) => { registered.set(name, cls); }),
    ];
    try {
      await import(pathToFileURL(WORKLET).href);
    } finally {
      for (const r of restore.reverse()) r();
    }
    const Capture = registered.get('ritsu-capture');
    assert.ok(Capture, 'registers ritsu-capture');
    const p = new Capture({ processorOptions: { batch: 256 } });
    const quantum = (start: number) => Float32Array.from({ length: 128 }, (_, i) => (start + i) / 1000);
    assert.equal(p.process([[quantum(0)]]), true);
    assert.equal(p.port.posted.length, 0);
    assert.equal(p.process([[quantum(128)]]), true);
    assert.equal(p.port.posted.length, 1);
    const first = p.port.posted[0];
    assert.ok(first.msg instanceof Float32Array);
    assert.equal(first.msg.length, 256);
    assert.equal(first.transfer?.[0], first.msg.buffer, 'the batch buffer is transferred');
    assert.ok(Math.abs(first.msg[255] - 0.255) < 1e-6);
    const sent = Array.from(first.msg);
    assert.equal(p.process([[quantum(256)]]), true);
    assert.equal(p.process([[]]), true);
    assert.equal(p.process([]), true);
    assert.deepEqual(Array.from(first.msg), sent, 'a sent batch is never written again');
    p.port.onmessage?.({ data: 'end' });
    assert.equal(p.port.posted.length, 3);
    const rest = p.port.posted[1];
    assert.ok(rest.msg instanceof Float32Array);
    assert.equal(rest.msg.length, 128);
    assert.equal(rest.transfer?.[0], rest.msg.buffer);
    assert.equal(p.port.posted[2].msg, 'ended');
    assert.equal(p.process([[quantum(384)]]), false, 'the processor stops after end');
    p.port.onmessage?.({ data: 'end' });
    assert.equal(p.port.posted.length, 3);
    assert.equal(new Capture({}).process([[quantum(0)]]), true, 'a missing batch size falls back to a default');
  });
});
