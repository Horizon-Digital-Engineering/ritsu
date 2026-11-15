import { describe, it, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MODEL, MANIFEST, MODELS, installModel, modelBytes, modelDir, published, readInstalled, removeModel, type Published,
} from '../speech/model.js';
import { needsRoot, runSpeechModel, type Io } from '../cli/commands/speech-model.js';

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

const BYTES = {
  config: Buffer.from('{"model_type":"whisper"}'),
  weightsA: randomBytes(300_000),
  weightsB: randomBytes(200_000),
};
const REV = 'a'.repeat(40);
const modelOf = (name: string, weights: Buffer): Published => ({
  name, repo: `example/whisper-${name}`, revision: REV, about: 'a test model',
  files: [
    { path: 'config.json', size: BYTES.config.length, sha256: sha(BYTES.config) },
    { path: 'onnx/encoder_model_quantized.onnx', size: weights.length, sha256: sha(weights) },
  ],
});
const A = modelOf('a.en', BYTES.weightsA);
const B = modelOf('b.en', BYTES.weightsB);

describe('speech model download', () => {
  let server: Server;
  let base = '';
  let dataDir = '';
  let tamper: 'none' | 'longer' | 'shorter' | 'flipped' | 'missing' | 'slow' = 'none';
  const requested: string[] = [];

  before(async () => {
    server = createServer((req, res) => {
      requested.push(req.url ?? '');
      const m = /^\/example\/whisper-([ab])\.en\/resolve\/a{40}\/(.+)$/.exec(req.url ?? '');
      if (!m) { res.writeHead(404).end(); return; }
      let body = m[2] === 'config.json' ? BYTES.config : (m[1] === 'a' ? BYTES.weightsA : BYTES.weightsB);
      if (m[2] !== 'config.json') {
        if (tamper === 'missing') { res.writeHead(404).end(); return; }
        if (tamper === 'longer') body = Buffer.concat([body, Buffer.from('x')]);
        if (tamper === 'shorter') body = body.subarray(0, body.length - 1);
        if (tamper === 'flipped') { body = Buffer.from(body); body[1000] ^= 0xff; }
      }
      if (tamper === 'slow') setTimeout(() => res.writeHead(200, { 'content-length': body.length }).end(body), 150);
      else res.writeHead(200, { 'content-length': body.length }).end(body);
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  after(() => { server.close(); rmSync(dataDir, { recursive: true, force: true }); });
  beforeEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = mkdtempSync(join(tmpdir(), 'ritsu-speech-model-'));
    tamper = 'none';
    requested.length = 0;
  });

  it('fetches every file at the pinned revision, checks it, and writes a manifest', async () => {
    const owned: string[] = [];
    const verified: string[] = [];
    let last = 0;
    const got = await installModel(dataDir, A, {
      baseUrl: base, chown: p => owned.push(p), verified: f => verified.push(f), progress: (_f, n) => { last = n; },
    });
    assert.deepEqual([got.name, got.revision, got.bytes], ['a.en', REV, modelBytes(A)]);
    assert.deepEqual(requested, [`/example/whisper-a.en/resolve/${REV}/config.json`, `/example/whisper-a.en/resolve/${REV}/onnx/encoder_model_quantized.onnx`]);
    assert.deepEqual(verified, ['config.json', 'onnx/encoder_model_quantized.onnx']);
    assert.equal(last, BYTES.weightsA.length);
    const dir = modelDir(dataDir);
    assert.ok(readFileSync(join(dir, 'onnx/encoder_model_quantized.onnx')).equals(BYTES.weightsA));
    const manifest = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) as { model: string; repo: string; revision: string; files: unknown[] };
    assert.deepEqual([manifest.model, manifest.repo, manifest.revision, manifest.files.length], ['a.en', 'example/whisper-a.en', REV, 2]);
    assert.equal(readInstalled(dataDir)?.name, 'a.en');
    const part = `${dir}.part`;
    assert.deepEqual([...owned].sort(), [part, join(part, 'config.json'), join(part, MANIFEST), join(part, 'onnx'), join(part, 'onnx/encoder_model_quantized.onnx')].sort());
    assert.equal(owned[0], part, 'the folder itself first');
    assert.ok(owned.indexOf(join(part, 'onnx')) < owned.indexOf(join(part, 'onnx/encoder_model_quantized.onnx')), 'parents before children');
    assert.equal(existsSync(part), false);
    assert.equal(existsSync(`${dir}.old`), false);
  });

  for (const [how, why] of [
    ['longer', /larger than the 300000 bytes recorded for it; nothing was replaced/],
    ['shorter', /arrived with 299999 of its 300000 bytes; nothing was replaced/],
    ['flipped', /does not match the SHA-256 recorded for it; nothing was replaced/],
    ['missing', /answered 404/],
  ] as const) {
    it(`a ${how} file fails the install and leaves the installed model as it was`, async () => {
      await installModel(dataDir, B, { baseUrl: base });
      const before = readFileSync(join(modelDir(dataDir), MANIFEST), 'utf8');
      tamper = how;
      await assert.rejects(installModel(dataDir, A, { baseUrl: base }), why);
      assert.equal(readFileSync(join(modelDir(dataDir), MANIFEST), 'utf8'), before);
      assert.ok(readFileSync(join(modelDir(dataDir), 'onnx/encoder_model_quantized.onnx')).equals(BYTES.weightsB));
      assert.equal(existsSync(`${modelDir(dataDir)}.part`), false, 'the staging folder is cleaned up');
    });
  }

  it('swaps a new model in whole, and remove takes it away', async () => {
    await installModel(dataDir, A, { baseUrl: base });
    await installModel(dataDir, B, { baseUrl: base });
    assert.equal(readInstalled(dataDir)?.name, 'b.en');
    assert.ok(readFileSync(join(modelDir(dataDir), 'onnx/encoder_model_quantized.onnx')).equals(BYTES.weightsB));
    assert.equal(existsSync(`${modelDir(dataDir)}.old`), false);
    assert.equal(removeModel(dataDir), true);
    assert.equal(existsSync(modelDir(dataDir)), false);
    assert.equal(readInstalled(dataDir), null);
    assert.equal(removeModel(dataDir), false);
  });

  it('runs one download at a time, and takes over a lock its holder left behind', async () => {
    tamper = 'slow';
    const first = installModel(dataDir, A, { baseUrl: base });
    await assert.rejects(installModel(dataDir, B, { baseUrl: base }), /another speech-model download is running \(process \d+\)/);
    assert.equal((await first).name, 'a.en');
    assert.equal(existsSync(`${modelDir(dataDir)}.lock`), false);
    tamper = 'none';
    // Above the kernel's largest pid, so no process holds it.
    writeFileSync(`${modelDir(dataDir)}.lock`, '4194399');
    assert.equal((await installModel(dataDir, B, { baseUrl: base })).name, 'b.en');
    assert.equal(existsSync(`${modelDir(dataDir)}.lock`), false);
  });

  it('the command lists, removes, and refuses an unknown model', async () => {
    const lines: string[] = [];
    const io: Io = { out: s => lines.push(s), err: s => lines.push(`ERR ${s}`), progress: () => undefined };
    const ctx = (subcommand: string | null, flags: Record<string, string | boolean> = {}) => ({ subcommand, positional: [], flags });
    assert.equal(await runSpeechModel(ctx(null, { list: true }), dataDir, io), 0);
    assert.match(lines.join('\n'), /none installed; download one with: sudo ritsu speech-model/);
    assert.match(lines.join('\n'), /small\.en\s+251\.8 MB/);
    lines.length = 0;
    assert.equal(await runSpeechModel(ctx('large-v3'), dataDir, io), 2);
    assert.match(lines[0], /^ERR no model 'large-v3'; pick one of tiny\.en, base\.en, small\.en$/);
    lines.length = 0;
    assert.equal(await runSpeechModel(ctx('tiny.en'), dataDir, io, base), 1, 'nothing at that address');
    assert.match(lines.at(-1) ?? '', /^ERR .*answered 404$/);
    assert.equal(readInstalled(dataDir), null);
    await installModel(dataDir, A, { baseUrl: base });
    lines.length = 0;
    assert.equal(await runSpeechModel(ctx('list'), dataDir, io), 0);
    assert.match(lines.at(-1) ?? '', /^installed: a\.en \(/);
    lines.length = 0;
    assert.equal(await runSpeechModel(ctx('remove'), dataDir, io), 0);
    assert.match(lines[0], /^removed a\.en from /);
  });
});

describe('whether the command re-runs itself under sudo', () => {
  let dir = '';
  let data = '';
  const root = process.getuid?.() === 0;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ritsu-speech-root-'));
    data = join(dir, 'data');
    mkdirSync(data);
  });
  after(() => { chmodSync(data, 0o700); rmSync(dir, { recursive: true, force: true }); });

  it('with no service env file, as in a dev checkout, only when the data folder is not writable', () => {
    assert.equal(needsRoot(join(dir, 'no-env'), data), false);
    assert.equal(needsRoot(join(dir, 'no-env'), join(dir, 'no-data')), true);
  });

  it('always when the env file cannot be read: it names the data folder the service uses', { skip: root }, () => {
    const env = join(dir, 'private-env');
    writeFileSync(env, 'DB_PATH=/var/lib/ritsu/ritsu.db\n', { mode: 0o000 });
    assert.equal(needsRoot(env, data), true);
    assert.equal(needsRoot(join(env, 'below-a-file'), data), true, 'any error but a missing file');
  });

  it('with a readable env file, when the data folder is not writable', { skip: root }, () => {
    const env = join(dir, 'readable-env');
    writeFileSync(env, 'DB_PATH=/var/lib/ritsu/ritsu.db\n', { mode: 0o600 });
    assert.equal(needsRoot(env, data), false);
    chmodSync(data, 0o500);
    assert.equal(needsRoot(env, data), true);
  });
});

describe('the pinned models', () => {
  it('name seven checked files at a full revision each, small.en by default', () => {
    for (const m of MODELS) {
      assert.match(m.revision, /^[0-9a-f]{40}$/, m.name);
      assert.equal(m.files.length, 7, m.name);
      assert.ok(m.files.every(f => /^[0-9a-f]{64}$/.test(f.sha256) && f.size > 0), m.name);
      assert.ok(m.files.some(f => f.path === 'onnx/encoder_model_quantized.onnx') && m.files.some(f => f.path === 'onnx/decoder_model_merged_quantized.onnx'), m.name);
    }
    assert.equal(published(DEFAULT_MODEL)?.repo, 'onnx-community/whisper-small.en');
    assert.equal(published('large'), null);
    assert.deepEqual(MODELS.map(m => Math.round(modelBytes(m) / 1e6)), [44, 80, 252]);
  });
});
