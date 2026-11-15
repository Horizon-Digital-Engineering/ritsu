/** Every file is checked against its pinned size and SHA-256 before the folder
 *  is swapped in, so it holds a complete, verified model or the one it had before. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stripTrailingSlashes } from '../util/path-utils.js';

export const MODEL_FOLDER = 'speech-model';
export const MANIFEST = 'manifest.json';
export const DEFAULT_MODEL = 'small.en';
export const HF_BASE = 'https://huggingface.co';
const STALL_MS = 60_000;

export interface PinnedFile { path: string; size: number; sha256: string }
export interface Published { name: string; repo: string; revision: string; about: string; files: PinnedFile[] }

/** Identical in every English model. */
const PREPROCESSOR: PinnedFile = { path: 'preprocessor_config.json', size: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' };
const TOKENIZER: PinnedFile = { path: 'tokenizer.json', size: 2_405_679, sha256: '5eb60cec1e77aeeb6869a2bb5a8e01a84c3fe5d072d75369343021fe6f5310d0' };
const TOKENIZER_CONFIG: PinnedFile = { path: 'tokenizer_config.json', size: 282_662, sha256: '93879c3dccdd4b976f709acd85b44778873f30c275e67026f30ca1e4c975230c' };
const ENCODER = 'onnx/encoder_model_quantized.onnx';
const DECODER = 'onnx/decoder_model_merged_quantized.onnx';

export const MODELS: readonly Published[] = [
  {
    name: 'tiny.en', repo: 'onnx-community/whisper-tiny.en', revision: '794207fec2761281fe63a23a94b7e9f53a4efbc1',
    about: 'the fastest; the most mistakes',
    files: [
      { path: 'config.json', size: 2_197, sha256: '251ea843b5901a99efa58c0b99b8052c6019aa3e7d2baf46693a1128ff606233' },
      { path: 'generation_config.json', size: 1_646, sha256: '7b2e8451ed5f118e75fdd991409d72119d21d2fef1eba9723f68fb9c57fe5dc9' },
      PREPROCESSOR, TOKENIZER, TOKENIZER_CONFIG,
      { path: ENCODER, size: 10_124_993, sha256: 'e93ec822f16a8fd264e7de972ad17d615ea7334b75a52d54c50c2e18dd503a25' },
      { path: DECODER, size: 30_718_858, sha256: 'c0592d0749413c960569e1c7fb806b060d5d18f3ebad4a95cbf9a77dc6e9be52' },
    ],
  },
  {
    name: 'base.en', repo: 'onnx-community/whisper-base.en', revision: '51eefc0af78b103839eda9e7e4f4186acc6517fe',
    about: 'fewer mistakes than tiny, about half again its time',
    files: [
      { path: 'config.json', size: 2_197, sha256: 'c8a0de5ed8a083565a4319db29d0c210fda35b4d6076c2d711cae53ae00f3cb1' },
      { path: 'generation_config.json', size: 1_556, sha256: '3479b1f44a07e41db799e22599222fee5816738036def94a39841cb9cdbb4120' },
      PREPROCESSOR, TOKENIZER, TOKENIZER_CONFIG,
      { path: ENCODER, size: 23_201_320, sha256: '6e8001198c490bbae018c0044f630c2915efb826bad957006ce36152d0ab2a10' },
      { path: DECODER, size: 53_692_803, sha256: 'dd4761a3f7add26afda3512abff4706920404c2517e85a9f2ff090b0c0987909' },
    ],
  },
  {
    name: 'small.en', repo: 'onnx-community/whisper-small.en', revision: '482fb8ba081b6e906f92efe103622316b2a0cc69',
    about: 'the fewest mistakes; the default',
    files: [
      { path: 'config.json', size: 2_203, sha256: '8825c4174cb86f94d9fa67614942f8aa17bfbbdf2fae5426d4adfd0bc5893c43' },
      { path: 'generation_config.json', size: 1_956, sha256: '5490747ca976d6b3765280a0697d66489020c2afa6e754244d9cd093e1639331' },
      PREPROCESSOR, TOKENIZER, TOKENIZER_CONFIG,
      { path: ENCODER, size: 92_326_170, sha256: 'dae677b93ca77f911d858238e277026fa8f95a94cb899ea443ec78ee62726edf' },
      { path: DECODER, size: 156_750_076, sha256: '29132c41903c252d0f2b9e59ee1e7d75f7d0b64d37f3e36d1ecc4a1a1af62953' },
    ],
  },
];

export function published(name: string): Published | null {
  return MODELS.find(m => m.name === name) ?? null;
}

export function modelBytes(m: Published): number {
  return m.files.reduce((n, f) => n + f.size, 0);
}

export function modelDir(dataDir: string): string { return join(dataDir, MODEL_FOLDER); }

/** `raw` is the manifest's text: a reinstall changes it. */
export interface InstalledModel {
  name: string;
  revision: string;
  installed_at: string;
  bytes: number;
  raw: string;
}

interface Manifest { model: string; repo: string; revision: string; installed_at: string; files: PinnedFile[] }

function isManifest(v: unknown): v is Manifest {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return typeof m.model === 'string' && typeof m.revision === 'string' && typeof m.installed_at === 'string'
    && Array.isArray(m.files) && m.files.length > 0
    && m.files.every(f => typeof (f as PinnedFile)?.path === 'string' && typeof (f as PinnedFile).size === 'number');
}

export function readInstalled(dataDir: string): InstalledModel | null {
  const dir = modelDir(dataDir);
  let raw: string;
  try { raw = readFileSync(join(dir, MANIFEST), 'utf8'); }
  catch { return null; }
  let m: unknown;
  try { m = JSON.parse(raw); }
  catch { return null; }
  if (!isManifest(m)) return null;
  for (const f of m.files) {
    try { if (statSync(join(dir, f.path)).size !== f.size) return null; }
    catch { return null; }
  }
  return { name: m.model, revision: m.revision, installed_at: m.installed_at, bytes: m.files.reduce((n, f) => n + f.size, 0), raw };
}

export type Progress = (file: string, got: number, size: number) => void;

export interface InstallOptions {
  /** Injected by tests. */
  baseUrl?: string;
  progress?: Progress;
  verified?: (file: string, size: number) => void;
  /** Hands each written path to the data dir's owner (the CLI runs as root). */
  chown?: (path: string) => void;
}

async function download(url: string, dest: string, file: PinnedFile, progress?: Progress): Promise<void> {
  const ctrl = new AbortController();
  let stall = setTimeout(() => ctrl.abort(), STALL_MS);
  const out = await open(dest, 'w');
  try {
    let res: Response;
    try { res = await fetch(url, { signal: ctrl.signal }); }
    catch (e) { throw new Error(`${url} could not be reached: ${(e as Error).message}`); }
    if (!res.ok || !res.body) throw new Error(`${url} answered ${res.status}`);
    const hash = createHash('sha256');
    const reader = res.body.getReader();
    let got = 0;
    try {
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        clearTimeout(stall);
        stall = setTimeout(() => ctrl.abort(), STALL_MS);
        const chunk: unknown = r.value;
        if (!(chunk instanceof Uint8Array)) throw new Error(`the download of ${file.path} did not arrive as bytes`);
        got += chunk.byteLength;
        if (got > file.size) throw new Error(`${file.path} is larger than the ${file.size} bytes recorded for it; nothing was replaced`);
        hash.update(chunk);
        await out.write(chunk);
        progress?.(file.path, got, file.size);
      }
    } catch (e) {
      if (ctrl.signal.aborted) throw new Error(`the download of ${file.path} stalled; nothing was replaced`);
      throw e;
    }
    if (got !== file.size) throw new Error(`${file.path} arrived with ${got} of its ${file.size} bytes; nothing was replaced`);
    if (hash.digest('hex') !== file.sha256) throw new Error(`${file.path} does not match the SHA-256 recorded for it; nothing was replaced`);
  } finally {
    clearTimeout(stall);
    await out.close();
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

function lock(dataDir: string): () => void {
  const path = `${modelDir(dataDir)}.lock`;
  try { writeFileSync(path, String(process.pid), { flag: 'wx' }); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const holder = Number(readFileSync(path, 'utf8').trim());
    if (Number.isInteger(holder) && holder > 0 && alive(holder)) {
      throw new Error(`another speech-model download is running (process ${holder}); if it is not, remove ${path}`);
    }
    writeFileSync(path, String(process.pid));
  }
  return () => rmSync(path, { force: true });
}

export async function installModel(dataDir: string, model: Published, opts: InstallOptions = {}): Promise<InstalledModel> {
  const unlock = lock(dataDir);
  try { return await stageAndSwap(dataDir, model, opts); }
  finally { unlock(); }
}

async function stageAndSwap(dataDir: string, model: Published, opts: InstallOptions): Promise<InstalledModel> {
  const base = stripTrailingSlashes(opts.baseUrl ?? HF_BASE);
  const target = modelDir(dataDir);
  const part = `${target}.part`;
  const old = `${target}.old`;
  rmSync(part, { recursive: true, force: true });
  try {
    for (const f of model.files) {
      mkdirSync(dirname(join(part, f.path)), { recursive: true });
      await download(`${base}/${model.repo}/resolve/${model.revision}/${f.path}`, join(part, f.path), f, opts.progress);
      opts.verified?.(f.path, f.size);
    }
    const manifest: Manifest = {
      model: model.name, repo: model.repo, revision: model.revision, installed_at: new Date().toISOString(), files: model.files,
    };
    writeFileSync(join(part, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    if (opts.chown) for (const p of walk(part)) opts.chown(p);
  } catch (e) {
    rmSync(part, { recursive: true, force: true });
    throw e;
  }
  rmSync(old, { recursive: true, force: true });
  if (existsSync(target)) renameSync(target, old);
  renameSync(part, target);
  rmSync(old, { recursive: true, force: true });
  const installed = readInstalled(dataDir);
  if (!installed) throw new Error(`${target} does not read back as an installed model`);
  return installed;
}

/** False when there was none. */
export function removeModel(dataDir: string): boolean {
  const unlock = lock(dataDir);
  try {
    const target = modelDir(dataDir);
    const had = existsSync(target);
    for (const p of [target, `${target}.part`, `${target}.old`]) rmSync(p, { recursive: true, force: true });
    return had;
  } finally { unlock(); }
}

function walk(dir: string): string[] {
  const out = [dir];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
