import { accessSync, constants, existsSync } from 'node:fs';
import type { Command, CommandContext } from '../registry.js';
import { loadConfig } from '../../config.js';
import { dataDirOf, matchOwner } from '../../backup.js';
import {
  DEFAULT_MODEL, MODELS, installModel, modelBytes, modelDir, published, readInstalled, removeModel,
} from '../../speech/model.js';

export interface Io { out: (s: string) => void; err: (s: string) => void; progress: (s: string) => void }

const stdio: Io = {
  out: s => { process.stdout.write(`${s}\n`); },
  err: s => { process.stderr.write(`${s}\n`); },
  progress: s => { if (process.stdout.isTTY) process.stdout.write(`\r\x1b[K${s}`); },
};

const mb = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1e3)} KB`);

function list(dataDir: string, io: Io): number {
  const installed = readInstalled(dataDir);
  io.out(`Whisper models for the built-in speech engine (${modelDir(dataDir)})`);
  for (const m of MODELS) {
    const mark = installed?.name === m.name ? '*' : ' ';
    io.out(`${mark} ${m.name.padEnd(9)}${mb(modelBytes(m)).padStart(10)}  ${m.about}`);
  }
  io.out(installed
    ? `installed: ${installed.name} (${installed.installed_at})`
    : 'none installed; download one with: sudo ritsu speech-model');
  return 0;
}

async function install(dataDir: string, name: string, io: Io, baseUrl?: string): Promise<number> {
  const model = published(name);
  if (!model) { io.err(`no model '${name}'; pick one of ${MODELS.map(m => m.name).join(', ')}`); return 2; }
  if (!existsSync(dataDir)) { io.err(`no data folder at ${dataDir}; start ritsu once first`); return 1; }
  io.out(`${model.name}: ${mb(modelBytes(model))} from ${model.repo} at ${model.revision.slice(0, 12)}`);
  let shown = -1;
  try {
    const got = await installModel(dataDir, model, {
      ...(baseUrl ? { baseUrl } : {}),
      progress: (file, n, size) => {
        const pct = Math.floor((n * 100) / size);
        if (pct === shown) return;
        shown = pct;
        io.progress(`  ${file.padEnd(42)}${String(pct).padStart(4)}% of ${mb(size)}`);
      },
      verified: (file, size) => {
        shown = -1;
        io.progress('');
        io.out(`  ${file.padEnd(42)}${mb(size).padStart(10)}  sha256 ok`);
      },
      chown: p => matchOwner(p, dataDir),
    });
    io.out(`installed ${got.name} in ${modelDir(dataDir)}; the service picks it up on the next recording`);
    return 0;
  } catch (e) {
    io.progress('');
    io.err((e as Error).message);
    return 1;
  }
}

export async function runSpeechModel(ctx: CommandContext, dataDir: string, io: Io = stdio, baseUrl?: string): Promise<number> {
  if (ctx.flags.list !== undefined || ctx.subcommand === 'list') return list(dataDir, io);
  if (ctx.subcommand === 'remove') {
    const was = readInstalled(dataDir);
    if (!existsSync(dataDir) || !removeModel(dataDir)) { io.out('no model installed'); return 0; }
    io.out(`removed ${was?.name ?? 'the model folder'} from ${dataDir}`);
    return 0;
  }
  return install(dataDir, ctx.subcommand ?? DEFAULT_MODEL, io, baseUrl);
}

function dataDir(): string { return dataDirOf(loadConfig().dbPath); }

const SERVICE_ENV = '/etc/ritsu/env';

/** A server's env file names the data folder and is private to the service user:
 *  a caller who cannot read it would resolve the wrong folder. */
export function needsRoot(envFile: string, dataFolder: string): boolean {
  try { accessSync(envFile, constants.R_OK); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return true; }
  try { accessSync(dataFolder, constants.W_OK); return false; }
  catch { return true; }
}

export const speechModelCommand: Command = {
  name: 'speech-model',
  summary: 'download the Whisper model for the built-in speech engine',
  get needsRoot() { return needsRoot(SERVICE_ENV, dataDir()); },
  help: () => [
    'ritsu speech-model — the Whisper model the built-in speech engine reads',
    '',
    `  ritsu speech-model [${MODELS.map(m => m.name).join('|')}]`,
    `                             download one (default ${DEFAULT_MODEL}) into the data folder`,
    '  ritsu speech-model --list  the models, their sizes, and which is installed',
    '  ritsu speech-model remove  delete the installed model',
    '',
    '  Files come from Hugging Face at a pinned revision. Each is checked against its',
    '  recorded size and SHA-256 before the folder is swapped in; a failed download',
    '  leaves the installed model as it was. The service reads the new model on the',
    '  next recording, without a restart.',
  ].join('\n'),
  run: (ctx: CommandContext) => runSpeechModel(ctx, dataDir()),
};
