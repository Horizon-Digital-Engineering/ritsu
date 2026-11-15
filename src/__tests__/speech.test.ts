import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readWav, resample, whisperSamples } from '../speech/wav.js';
import { BuiltinWhisper, speechThreads, workerLoader, type AsrModel } from '../speech/builtin.js';
import { OPENAI_URL, transcribeLocal, transcribeOpenAi } from '../speech/engines.js';
import { NOTHING_HEARD, SpeechError, SpeechService, speechStatus, storeSources, whisperUrlError, type SpeechDeps } from '../speech/index.js';
import { MANIFEST, modelDir } from '../speech/model.js';
import { openDatabase } from '../db.js';
import { ApiKeyStore } from '../auth/api-key-store.js';
import { SettingsStore } from '../settings-store.js';
import { _resetKeyCacheForTests } from '../util/secret-crypto.js';
import { checkVoice } from '../cli/commands/doctor.js';
import { PROXY_LOGIN, fakeModel, toneWav } from './speech-helpers.js';

const KEY = 'openai-key-for-the-test';
const OLDER_KEY = 'an-older-openai-key-for-the-test';

const rms = (a: Float32Array, from = 0, to = a.length): number => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / (to - from));
};

describe('WAV reading', () => {
  it('reads rate, channels and length, and tells speech from silence', () => {
    const w = readWav(toneWav({ seconds: 2 }));
    assert.ok(w);
    assert.deepEqual([w.rate, w.channels, w.silent], [16_000, 1, false]);
    assert.ok(Math.abs(w.seconds - 2) < 1e-9);
    assert.equal(readWav(toneWav({ seconds: 1, amplitude: 0 }))?.silent, true);
    assert.equal(readWav(toneWav({ seconds: 1, amplitude: 0.005 }))?.silent, true, 'below -40 dBFS');
    const stereo = readWav(toneWav({ seconds: 1, rate: 44_100, channels: 2 }));
    assert.deepEqual([stereo?.rate, stereo?.channels, stereo?.seconds], [44_100, 2, 1]);
  });

  it('refuses anything but 16-bit PCM WAV', () => {
    assert.equal(readWav(Buffer.from('not audio at all')), null);
    assert.equal(readWav(Buffer.from('RIFF....WAVEjunk')), null);
    assert.equal(readWav(toneWav({ seconds: 0.5, bits: 8 })), null);
    assert.equal(readWav(toneWav({ seconds: 0.5, format: 3 })), null, 'float samples');
    assert.equal(readWav(toneWav({ seconds: 0.5, rate: 4_000 })), null, 'below telephone rate');
    const noData = toneWav({ seconds: 0.5 }).subarray(0, 36);
    assert.equal(readWav(noData), null);
  });

  it('skips other chunks, pads odd ones, and takes what arrived of an open-ended data chunk', () => {
    const plain = toneWav({ seconds: 1 });
    const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([3, 0, 0, 0]), Buffer.from('abc'), Buffer.from([0])]);
    const withList = Buffer.concat([plain.subarray(0, 36), list, plain.subarray(36)]);
    assert.equal(readWav(withList)?.seconds, 1);
    const streaming = Buffer.from(plain);
    streaming.writeUInt32LE(0xffffffff, 40);
    assert.equal(readWav(streaming)?.seconds, 1);
    const ragged = Buffer.concat([plain, Buffer.from([1])]);
    assert.equal(readWav(ragged)?.data.length, 32_000, 'a trailing half sample is dropped');
  });
});

describe('samples for Whisper', () => {
  it('passes 16 kHz mono through as floats', () => {
    const pcm = whisperSamples(readWav(toneWav({ seconds: 0.5, amplitude: 0.5 }))!);
    assert.equal(pcm.length, 8_000);
    const peak = pcm.reduce((m, v) => Math.max(m, v), 0);
    assert.ok(Math.abs(peak - 0.5) < 0.01, String(peak));
  });

  it('averages channels and resamples to 16 kHz', () => {
    const pcm = whisperSamples(readWav(toneWav({ seconds: 1, rate: 48_000, channels: 2, amplitude: 0.5 }))!);
    assert.equal(pcm.length, 16_000);
    assert.ok(Math.abs(rms(pcm, 200, 15_800) - 0.5 / Math.SQRT2) < 0.01);
    const up = whisperSamples(readWav(toneWav({ seconds: 1, rate: 8_000, amplitude: 0.5 }))!);
    assert.equal(up.length, 16_000);
    assert.ok(Math.abs(rms(up, 200, 15_800) - 0.5 / Math.SQRT2) < 0.01);
  });

  it('keeps tones below the new Nyquist and filters those above it instead of folding them down', () => {
    const tone = (freq: number): Float32Array => Float32Array.from({ length: 48_000 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * freq * i) / 48_000));
    const kept = resample(tone(5_000), 48_000, 16_000);
    assert.ok(rms(kept, 200, 15_800) > 0.33, 'a 5 kHz tone survives');
    const gone = resample(tone(12_000), 48_000, 16_000);
    assert.ok(rms(gone, 200, 15_800) < 0.01, 'a 12 kHz tone would alias to 4 kHz; it is removed');
  });
});

describe('engine status', () => {
  let dataDir = '';
  before(() => { dataDir = mkdtempSync(join(tmpdir(), 'ritsu-speech-status-')); });
  after(() => { rmSync(dataDir, { recursive: true, force: true }); });

  const status = (settings: Record<string, string>, openai = false, dir = dataDir) =>
    speechStatus({ dataDir: dir, setting: k => settings[k] ?? null, hasOpenAiKey: () => openai });

  it('says what to do when nothing can run, and lists every engine', () => {
    const st = status({});
    assert.equal(st.choice, 'auto');
    assert.equal(st.engine, null);
    assert.match(st.sentence, /^No speech engine can run yet: run `ritsu speech-model` on the server/);
    assert.deepEqual(st.engines.map(e => [e.id, e.available]), [['builtin', false], ['local', false], ['openai', false]]);
    assert.deepEqual(st.engines.map(e => e.cost), ['free', 'free', '$0.0045 a minute']);
    assert.equal(st.max_seconds, 300);
    assert.equal(st.whisper_url, '');
    assert.equal(st.model, null);
  });

  it('auto takes the first that can run: built-in, then the whisper server, then OpenAI', () => {
    const url = 'http://127.0.0.1:8080/inference';
    assert.equal(status({}, true).engine, 'openai');
    assert.equal(status({ 'speech.whisper_url': url }, true).engine, 'local');
    assert.equal(status({ 'speech.whisper_url': url }, true).sentence, `Speech goes to the whisper server at ${url}.`);
    fakeModel(dataDir, 'small.en');
    const st = status({ 'speech.whisper_url': url }, true);
    assert.equal(st.engine, 'builtin');
    assert.equal(st.sentence, 'Speech goes to the built-in Whisper (small.en).');
    assert.equal(st.engines[0].detail, "small.en on this machine's processor; the audio never leaves it.");
    assert.equal(st.model, 'small.en');
    rmSync(modelDir(dataDir), { recursive: true });
  });

  it('a chosen engine is used only when it can run; off is off', () => {
    assert.equal(status({ 'speech.engine': 'openai' }, true).engine, 'openai');
    const st = status({ 'speech.engine': 'local' }, true);
    assert.equal(st.engine, null);
    assert.match(st.sentence, /whisper server is chosen but has no address/);
    assert.match(status({ 'speech.engine': 'builtin' }).sentence, /built-in Whisper is chosen but has no model/);
    const off = status({ 'speech.engine': 'off' }, true);
    assert.deepEqual([off.choice, off.engine, off.sentence], ['off', null, 'Voice is off.']);
    assert.equal(status({ 'speech.engine': 'cuda' }, true).choice, 'auto', 'an unknown stored value reads as auto');
    assert.equal(status({ 'speech.whisper_url': 'ftp://example.test/inference' }).engines[1].available, false);
  });

  it('never sends a recording to a whisper address with a login: fetch refuses it and the error would repeat it', () => {
    const url = `https://${PROXY_LOGIN}@whisper.example.test/inference`;
    for (const bad of [url, 'https://operator@whisper.example.test/inference']) {
      assert.equal(whisperUrlError(bad), 'the whisper server address cannot carry a user name or password');
    }
    assert.equal(whisperUrlError('http://127.0.0.1:8080/inference'), null);
    const st = status({ 'speech.whisper_url': url }, true);
    assert.deepEqual([st.engines[1].available, st.engine], [false, 'openai'], 'auto goes on to an engine that works');
    assert.doesNotMatch(st.sentence + st.engines[1].detail, /proxy-login/);
  });

  it('a model folder whose files went missing or changed size is not installed', () => {
    fakeModel(dataDir, 'tiny.en');
    assert.equal(status({}).engine, 'builtin');
    writeFileSync(join(modelDir(dataDir), 'config.json'), '{"changed": true}');
    assert.equal(status({}).engine, null);
    writeFileSync(join(modelDir(dataDir), MANIFEST), 'not json');
    assert.equal(status({}).model, null);
    rmSync(modelDir(dataDir), { recursive: true });
  });
});

interface Captured { url: string; headers: IncomingMessage['headers']; fields: Map<string, string>; file: { name: string; type: string; size: number } | null }

async function captureServer(reply: (c: Captured) => [number, string]): Promise<{ server: Server; url: string; seen: Captured[] }> {
  const seen: Captured[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const form = new Response(body, { headers: { 'content-type': req.headers['content-type'] ?? '' } });
      void form.formData().then(fd => {
        const fields = new Map<string, string>();
        let file: Captured['file'] = null;
        for (const [k, v] of fd.entries()) {
          if (typeof v === 'string') fields.set(k, v);
          else file = { name: v.name, type: v.type, size: v.size };
        }
        const c: Captured = { url: req.url ?? '', headers: req.headers, fields, file };
        seen.push(c);
        const [status, text] = reply(c);
        res.writeHead(status, { 'content-type': 'application/json' }).end(text);
      });
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/inference`, seen };
}

describe('the whisper server engine', () => {
  it('posts the WAV with the fields whisper.cpp reads and returns its text', async () => {
    const { server, url, seen } = await captureServer(() => [200, JSON.stringify({ text: ' hello there\n' })]);
    try {
      const wav = toneWav({ seconds: 1 });
      assert.equal(await transcribeLocal(url, wav, 'A conversation with Ada.'), ' hello there\n');
      const c = seen[0];
      assert.equal(c.url, '/inference');
      assert.deepEqual(c.file, { name: 'speech.wav', type: 'audio/wav', size: wav.length });
      assert.equal(c.fields.get('response_format'), 'json');
      assert.equal(c.fields.get('temperature'), '0.0');
      assert.equal(c.fields.get('prompt'), 'A conversation with Ada.');
      await transcribeLocal(url, wav, '');
      assert.equal(seen[1].fields.has('prompt'), false, 'no context, no prompt');
    } finally { server.close(); }
  });

  it('says what went wrong: an error status, an answer that is not JSON, nobody listening', async () => {
    const { server, url } = await captureServer(c => (c.fields.get('prompt') === 'garbled' ? [200, '<html>'] : [500, JSON.stringify({ error: 'failed to read WAV' })]));
    try {
      const wav = toneWav({ seconds: 1 });
      await assert.rejects(transcribeLocal(url, wav, 'x'), /answered 500: failed to read WAV/);
      await assert.rejects(transcribeLocal(url, wav, 'garbled'), /answered something that is not JSON/);
    } finally { server.close(); }
    await assert.rejects(transcribeLocal(url, toneWav({ seconds: 1 }), ''), /could not be reached/);
  });
});

describe('the OpenAI engine', () => {
  it('posts to the transcription endpoint with gpt-transcribe and the key as a bearer token', async () => {
    let seen: { url: string; auth: string | null; fields: Map<string, string>; file: File | null } | null = null;
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const fd = init?.body as FormData;
      const fields = new Map<string, string>();
      let file: File | null = null;
      for (const [k, v] of fd.entries()) {
        if (typeof v === 'string') fields.set(k, v);
        else file = v;
      }
      seen = { url: input instanceof Request ? input.url : input.toString(), auth: new Headers(init?.headers).get('authorization'), fields, file };
      return new Response(JSON.stringify({ text: 'Ask not.' }), { status: 200 });
    };
    assert.equal(await transcribeOpenAi(KEY, toneWav({ seconds: 1 }), 'A conversation with Ada.', fakeFetch), 'Ask not.');
    assert.ok(seen);
    const s = seen as { url: string; auth: string | null; fields: Map<string, string>; file: File | null };
    assert.equal(s.url, OPENAI_URL);
    assert.equal(s.url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(s.auth, `Bearer ${KEY}`);
    assert.equal(s.fields.get('model'), 'gpt-transcribe');
    assert.equal(s.fields.get('prompt'), 'A conversation with Ada.');
    assert.equal(s.file?.name, 'speech.wav');
  });

  it("passes OpenAI's own error message through", async () => {
    const fakeFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ error: { message: 'Incorrect API key provided.' } }), { status: 401 });
    await assert.rejects(transcribeOpenAi(KEY, toneWav({ seconds: 1 }), '', fakeFetch), /OpenAI answered 401: Incorrect API key provided\./);
  });
});

function fakeAsr(text = 'words from the fake model') {
  const log = { loads: 0, disposed: 0, running: 0, maxRunning: 0, dirs: [] as string[], threads: [] as number[], samples: [] as number[] };
  const load = async (dir: string, threads: number): Promise<AsrModel> => {
    log.loads++;
    log.dirs.push(dir);
    log.threads.push(threads);
    return {
      transcribe: async (pcm) => {
        log.running++;
        log.maxRunning = Math.max(log.maxRunning, log.running);
        await new Promise(r => setTimeout(r, 15));
        log.running--;
        log.samples.push(pcm.length);
        return ` ${text} `;
      },
      dispose: async () => { log.disposed++; },
    };
  };
  return { load, log };
}

describe('the built-in engine', () => {
  let dataDir = '';
  before(() => { dataDir = mkdtempSync(join(tmpdir(), 'ritsu-speech-builtin-')); });
  after(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it('caps its threads at half the cores, at most 8', () => {
    const n = speechThreads();
    assert.ok(n >= 1 && n <= 8);
  });

  it('loads once from the model folder, runs one recording at a time, and refuses without a model', async () => {
    const { load, log } = fakeAsr();
    const engine = new BuiltinWhisper(dataDir, { load, threads: 3 });
    await assert.rejects(engine.transcribe(new Float32Array(16_000)), /no built-in model is installed/);
    fakeModel(dataDir, 'tiny.en');
    const texts = await Promise.all([1, 2, 3].map(n => engine.transcribe(new Float32Array(n * 16_000))));
    assert.deepEqual(texts, Array(3).fill(' words from the fake model '));
    assert.equal(log.loads, 1);
    assert.deepEqual(log.dirs, [modelDir(dataDir)]);
    assert.deepEqual(log.threads, [3]);
    assert.equal(log.maxRunning, 1, 'never two at once');
    assert.deepEqual(log.samples, [16_000, 32_000, 48_000], 'in arrival order');
    await engine.close();
    assert.equal(log.disposed, 1);
    rmSync(modelDir(dataDir), { recursive: true });
  });

  it('reloads when the manifest changes and lets the model go after an idle spell', async () => {
    const { load, log } = fakeAsr();
    const engine = new BuiltinWhisper(dataDir, { load, idleMs: 40 });
    fakeModel(dataDir, 'tiny.en', '2026-11-14T00:00:00.000Z');
    await engine.transcribe(new Float32Array(100));
    await engine.transcribe(new Float32Array(100));
    assert.equal(log.loads, 1);
    fakeModel(dataDir, 'small.en', '2026-11-14T01:00:00.000Z');
    await engine.transcribe(new Float32Array(100));
    assert.deepEqual([log.loads, log.disposed], [2, 1], 'the old model is let go before the new one loads');
    await new Promise(r => setTimeout(r, 120));
    assert.equal(engine.loaded, false);
    assert.equal(log.disposed, 2);
    await engine.transcribe(new Float32Array(100));
    assert.equal(log.loads, 3, 'the next recording loads it again');
    await engine.close();
    rmSync(modelDir(dataDir), { recursive: true });
  });
});

const STAND_IN = `
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parentPort, threadId } from 'node:worker_threads';
let dir = '';
parentPort.on('message', (req) => {
  if (req.load) dir = req.load.dir;
  if (!req.pcm) { parentPort.postMessage({ id: req.id, text: '' }); return; }
  if (existsSync(join(dir, 'exit-once'))) { rmSync(join(dir, 'exit-once')); process.exit(3); }
  if (existsSync(join(dir, 'throw'))) throw new Error('the model fell over');
  parentPort.postMessage({ id: req.id, text: 'thread ' + threadId + ': ' + req.pcm.length + ' samples' });
});
`;

describe('the built-in engine on its worker thread', { timeout: 20_000 }, () => {
  let dir = '';
  let standIn: URL;
  let broken: URL;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ritsu-speech-worker-'));
    writeFileSync(join(dir, 'stand-in.mjs'), STAND_IN);
    writeFileSync(join(dir, 'broken.mjs'), "throw new Error('the worker could not start');\n");
    standIn = pathToFileURL(join(dir, 'stand-in.mjs'));
    broken = pathToFileURL(join(dir, 'broken.mjs'));
  });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('moves the samples to the thread, which outlives a release', async () => {
    const load = workerLoader(standIn);
    const first = await load(dir, 2);
    const pcm = new Float32Array(1_600);
    const said = await first.transcribe(pcm);
    assert.match(said, /^thread \d+: 1600 samples$/);
    assert.equal(pcm.length, 0, 'moved, not copied');
    await first.dispose();
    const again = await load(dir, 2);
    assert.equal(await again.transcribe(new Float32Array(5)), said.replace('1600', '5'), 'the same thread');
    await again.dispose();
  });

  it('a thread that exits or throws fails the call waiting on it and every call after; the next load starts a new one', async () => {
    const load = workerLoader(standIn);
    const model = await load(dir, 1);
    const before = await model.transcribe(new Float32Array(5));
    writeFileSync(join(dir, 'exit-once'), '');
    await assert.rejects(model.transcribe(new Float32Array(5)), /the speech worker stopped \(exit code 3\)/);
    await assert.rejects(model.transcribe(new Float32Array(5)), /exit code 3/, 'a dead thread answers at once');
    await model.dispose();
    const fresh = await load(dir, 1);
    const after = await fresh.transcribe(new Float32Array(5));
    assert.match(after, /^thread \d+: 5 samples$/);
    assert.notEqual(after, before, 'a new thread');
    writeFileSync(join(dir, 'throw'), '');
    try {
      await assert.rejects(fresh.transcribe(new Float32Array(5)), /the model fell over/);
    } finally { rmSync(join(dir, 'throw')); }
    await assert.rejects(workerLoader(broken)(dir, 1), /the worker could not start/);
  });

  it('a recording whose thread died fails with the reason, and the next runs on a fresh thread', async () => {
    const dataDir = join(dir, 'data');
    fakeModel(dataDir, 'tiny.en');
    const engine = new BuiltinWhisper(dataDir, { load: workerLoader(standIn), threads: 1 });
    writeFileSync(join(modelDir(dataDir), 'exit-once'), '');
    await assert.rejects(engine.transcribe(new Float32Array(5)), /exit code 3/);
    assert.equal(engine.loaded, false, 'the dead model was let go');
    assert.match(await engine.transcribe(new Float32Array(7)), /: 7 samples$/);
    await engine.close();
  });
});

describe('SpeechService', () => {
  let dataDir = '';
  before(() => { dataDir = mkdtempSync(join(tmpdir(), 'ritsu-speech-service-')); });
  after(() => { rmSync(dataDir, { recursive: true, force: true }); });

  const service = (over: Partial<SpeechDeps> = {}, settings: Record<string, string> = {}) => {
    const fake = fakeAsr('ask not');
    const svc = new SpeechService({
      dataDir, setting: k => settings[k] ?? null, hasOpenAiKey: () => false, openAiKey: () => null,
      builtin: { load: fake.load }, ...over,
    });
    return { svc, log: fake.log };
  };

  it('silence and very short recordings come back with a note and reach no engine', async () => {
    const { svc, log } = service();
    fakeModel(dataDir, 'tiny.en');
    try {
      assert.deepEqual(await svc.transcribe(toneWav({ seconds: 2, amplitude: 0 })), { text: '', engine: null, seconds: 2, note: NOTHING_HEARD });
      assert.deepEqual(await svc.transcribe(toneWav({ seconds: 0.2 })), { text: '', engine: null, seconds: 0.2, note: NOTHING_HEARD });
      assert.equal(log.loads, 0);
    } finally { await svc.close(); rmSync(modelDir(dataDir), { recursive: true }); }
  });

  it('refuses what is not a WAV, what is too long, and recordings with nowhere to go', async () => {
    const { svc } = service();
    const status = async (p: Promise<unknown>): Promise<number> => {
      try { await p; return 200; } catch (e) { assert.ok(e instanceof SpeechError); return e.status; }
    };
    assert.equal(await status(svc.transcribe(Buffer.from('nope'))), 400);
    assert.equal(await status(svc.transcribe(toneWav({ seconds: 302 }))), 413);
    assert.equal(await status(svc.transcribe(toneWav({ seconds: 300.5 }))), 422, 'the page stopping a moment late is not too long');
    await assert.rejects(svc.transcribe(toneWav({ seconds: 1 })), /No speech engine can run yet/);
  });

  it('sends speech to the engine and trims its words', async () => {
    const { svc, log } = service();
    fakeModel(dataDir, 'small.en');
    try {
      assert.deepEqual(await svc.transcribe(toneWav({ seconds: 1.5, rate: 48_000 })), { text: 'ask not', engine: 'builtin', seconds: 1.5 });
      assert.deepEqual(log.samples, [24_000], 'resampled to 16 kHz');
    } finally { await svc.close(); rmSync(modelDir(dataDir), { recursive: true }); }
  });

  it('an engine failure is a 502 naming the engine', async () => {
    const failing = async (): Promise<Response> => new Response('{"error":"model not loaded"}', { status: 503 });
    const { svc } = service({ hasOpenAiKey: () => true, openAiKey: () => KEY, fetch: failing }, { 'speech.engine': 'openai' });
    await assert.rejects(svc.transcribe(toneWav({ seconds: 1 })), (e: unknown) =>
      e instanceof SpeechError && e.status === 502 && /^OpenAI gpt-transcribe failed: OpenAI answered 503: model not loaded/.test(e.message));
  });

  it('reads the newest OpenAI key that is not revoked, and the settings, from the stores', () => {
    process.env.RITSU_MASTER_KEY = Buffer.alloc(32, 9).toString('base64');
    _resetKeyCacheForTests();
    const db = openDatabase(':memory:');
    const keys = new ApiKeyStore(db);
    const settings = new SettingsStore(db);
    const src = storeSources(dataDir, settings, keys);
    assert.equal(src.hasOpenAiKey(), false);
    keys.mint('other', 'anthropic', 'not-an-openai-key');
    assert.equal(src.hasOpenAiKey(), false);
    keys.mint('old', 'openai', OLDER_KEY);
    const newest = keys.mint('new', 'openai', KEY);
    assert.equal(src.openAiKey(), KEY);
    keys.revoke(newest.id);
    assert.equal(src.openAiKey(), OLDER_KEY);
    settings.set('speech.engine', 'openai');
    assert.equal(speechStatus(src).engine, 'openai');
  });
});

describe('ritsu doctor voice check', () => {
  it('is ok with the sentence when an engine can run, a warning with it otherwise', () => {
    process.env.RITSU_MASTER_KEY = Buffer.alloc(32, 5).toString('base64');
    _resetKeyCacheForTests();
    const dataDir = mkdtempSync(join(tmpdir(), 'ritsu-speech-doctor-'));
    const dbPath = join(dataDir, 'ritsu.db');
    try {
      assert.deepEqual(checkVoice(dbPath), { name: 'voice', status: 'warn', detail: speechStatus({ dataDir, setting: () => null, hasOpenAiKey: () => false }).sentence });
      const db = openDatabase(dbPath);
      const settings = new SettingsStore(db);
      new ApiKeyStore(db).mint('speech', 'openai', KEY);
      assert.deepEqual(checkVoice(dbPath), { name: 'voice', status: 'ok', detail: 'Speech goes to OpenAI gpt-transcribe, at $0.0045 a minute.' });
      fakeModel(dataDir, 'tiny.en');
      assert.equal(checkVoice(dbPath).detail, 'Speech goes to the built-in Whisper (tiny.en).');
      settings.set('speech.engine', 'off');
      assert.deepEqual(checkVoice(dbPath), { name: 'voice', status: 'warn', detail: 'Voice is off.' });
      db.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
});
