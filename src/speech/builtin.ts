import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { logger } from '../util/log.js';
import { modelDir, readInstalled } from './model.js';

const IDLE_MS = 15 * 60_000;

export interface AsrModel {
  /** Expects 16 kHz mono; may take over `pcm`'s buffer. */
  transcribe(pcm: Float32Array): Promise<string>;
  dispose(): Promise<void>;
}

export type AsrLoader = (dir: string, threads: number) => Promise<AsrModel>;

export type WorkerJob = { load: { dir: string; threads: number } } | { pcm: Float32Array } | { unload: true };
export type WorkerRequest = WorkerJob & { id: number };
export interface WorkerReply { id: number; text?: string; error?: string }

/** Half the cores, at most 8: the rest of the box keeps serving while a recording is read. */
export function speechThreads(): number {
  return Math.min(8, Math.max(1, Math.floor(availableParallelism() / 2)));
}

interface Waiter { resolve: (text: string) => void; reject: (e: Error) => void }

/** Outlives a release: a new thread per load left the process about 100 MB
 *  larger after every idle release. */
class WhisperThread {
  private readonly worker: Worker;
  private readonly waiting = new Map<number, Waiter>();
  private gone: Error | null = null;
  private seq = 0;

  constructor(script: URL) {
    this.worker = new Worker(script);
    this.worker.unref();
    this.worker.on('message', (m: WorkerReply) => this.settle(m));
    this.worker.on('error', (e: Error) => this.stop(e));
    this.worker.on('exit', code => this.stop(new Error(`the speech worker stopped (exit code ${code})`)));
  }

  get alive(): boolean { return this.gone === null; }

  call(job: WorkerJob): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.gone) { reject(this.gone); return; }
      const id = ++this.seq;
      const moved = 'pcm' in job && job.pcm.buffer instanceof ArrayBuffer ? [job.pcm.buffer] : [];
      this.worker.postMessage({ ...job, id } satisfies WorkerRequest, moved);
      this.waiting.set(id, { resolve, reject });
      // Held only while it owes an answer, so an idle model never keeps a process alive.
      this.worker.ref();
    });
  }

  private settle(m: WorkerReply): void {
    const waiter = this.waiting.get(m.id);
    this.waiting.delete(m.id);
    if (this.waiting.size === 0) this.worker.unref();
    if (m.error === undefined) waiter?.resolve(m.text ?? '');
    else waiter?.reject(new Error(m.error));
  }

  private stop(e: Error): void {
    this.gone ??= e;
    for (const waiter of this.waiting.values()) waiter.reject(this.gone);
    this.waiting.clear();
  }
}

export function workerLoader(script: URL): AsrLoader {
  let thread: WhisperThread | null = null;
  return async (dir, threads) => {
    if (!thread?.alive) thread = new WhisperThread(script);
    const t = thread;
    await t.call({ load: { dir, threads } });
    return {
      transcribe: pcm => t.call({ pcm }),
      dispose: async () => { if (t.alive) await t.call({ unload: true }); },
    };
  };
}

/** Under tsx the .js name resolves to the .ts source. */
const WHISPER_WORKER = new URL('./whisper-worker.js', import.meta.url);

export interface BuiltinOptions {
  load?: AsrLoader;
  idleMs?: number;
  threads?: number;
}

export class BuiltinWhisper {
  private model: AsrModel | null = null;
  private loadedFrom: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idle: NodeJS.Timeout | null = null;
  private readonly load: AsrLoader;
  private readonly idleMs: number;
  private readonly threads: number;

  constructor(private readonly dataDir: string, opts: BuiltinOptions = {}) {
    this.load = opts.load ?? workerLoader(WHISPER_WORKER);
    this.idleMs = opts.idleMs ?? IDLE_MS;
    this.threads = opts.threads ?? speechThreads();
  }

  get loaded(): boolean { return this.model !== null; }

  transcribe(pcm: Float32Array): Promise<string> {
    return this.serial(() => this.run(pcm));
  }

  async close(): Promise<void> {
    this.disarm();
    await this.serial(() => this.release());
  }

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async run(pcm: Float32Array): Promise<string> {
    this.disarm();
    try {
      const installed = readInstalled(this.dataDir);
      if (!installed) throw new Error('no built-in model is installed');
      if (this.model && this.loadedFrom !== installed.raw) await this.release();
      if (!this.model) {
        const t0 = Date.now();
        this.model = await this.load(modelDir(this.dataDir), this.threads);
        this.loadedFrom = installed.raw;
        logger.info('speech.builtin.loaded', { model: installed.name, threads: this.threads, ms: Date.now() - t0 });
      }
      try {
        return await this.model.transcribe(pcm);
      } catch (e) {
        // A worker that died answers nothing again; the next recording loads a fresh one.
        await this.release();
        throw e;
      }
    } finally {
      this.arm();
    }
  }

  private async release(): Promise<boolean> {
    const model = this.model;
    this.model = null;
    this.loadedFrom = null;
    if (!model) return false;
    await model.dispose();
    return true;
  }

  private arm(): void {
    if (!this.model) return;
    this.idle = setTimeout(() => {
      this.idle = null;
      this.serial(() => this.release())
        .then(had => { if (had) logger.info('speech.builtin.released', { idle_minutes: Math.round(this.idleMs / 60_000) }); })
        .catch((e: unknown) => logger.warn('speech.builtin.release-failed', { err: (e as Error).message }));
    }, this.idleMs);
    this.idle.unref();
  }

  private disarm(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }
}
