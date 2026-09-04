/**
 * MemoryService — the host-side resilience layer over the MemoryBackend seam.
 *
 * The backends (sqlite / flashback / fake) are honest: flashback throws on a
 * network failure, sqlite never touches the network. This service owns the
 * POLICY that turns those into a store a turn can lean on without ever being
 * blocked or failed by a remote outage:
 *
 *   sqlite    on-box only. Today's behavior. No network, ever.
 *   flashback flashback authoritative for reads; a sqlite shadow write keeps a
 *             local backstop. A read failure falls back to the sqlite copy.
 *   dual      sqlite authoritative for reads AND awaited on write; flashback
 *             written FIRE-AND-FORGET (timeout + swallow + one log line). A
 *             flashback outage or slowness can never block or fail a turn.
 *
 * The invariant across every mode: the sqlite write is awaited and the read
 * always resolves from a store that's on this box, so the caller's turn
 * completes regardless of the remote's health.
 */
import type { MemoryMode } from './config.js';
import { logger } from '../util/log.js';
import type {
  MemoryBackend, RawRecordInput, Scope, QueryFilter, AssembledContext, RawRecord,
} from './backend.js';


export interface MemoryServiceDeps {
  mode: MemoryMode;
  /** Always present — the on-box store and the backstop. */
  sqlite: MemoryBackend;
  /** Present only when a remote backend is configured + reachable-by-config. */
  flashback?: MemoryBackend;
  /** Fire-and-forget write budget (ms) before the flashback write is abandoned. */
  fireAndForgetTimeoutMs?: number;
}

const DEFAULT_FF_TIMEOUT_MS = 5000;

/** Resolve after `ms`, marking the wrapped promise as timed-out rather than
 *  letting it hang the caller. The underlying request keeps running (and its
 *  own AbortSignal.timeout still fires) but we stop waiting on it. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    // node timers: don't keep the event loop alive for a fire-and-forget write.
    if (typeof t.unref === 'function') t.unref();
    p.then(
      v => { clearTimeout(t); resolve(v); },
      (e: unknown) => { clearTimeout(t); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

export class MemoryService {
  private readonly mode: MemoryMode;
  private readonly sqlite: MemoryBackend;
  private readonly flashback?: MemoryBackend;
  private readonly ffTimeoutMs: number;
  private readonly writeChains = new Map<string, Promise<unknown>>();

  constructor(deps: MemoryServiceDeps) {
    this.mode = deps.mode;
    this.sqlite = deps.sqlite;
    this.flashback = deps.flashback;
    this.ffTimeoutMs = deps.fireAndForgetTimeoutMs ?? DEFAULT_FF_TIMEOUT_MS;
    if (this.mode !== 'sqlite' && !this.flashback) {
      // Requested a remote mode but no reachable remote was wired — run
      // sqlite-only and say so once, loudly, rather than silently.
      logger.warn('memory.remote-unconfigured', { mode: this.mode });
    }
  }

  /** Which store answers reads for the active mode (never null; sqlite is the
   *  floor). */
  private get reader(): MemoryBackend {
    return this.mode === 'flashback' && this.flashback ? this.flashback : this.sqlite;
  }

  /**
   * Record a turn/fact. Semantics per mode:
   *   sqlite    write sqlite, awaited.
   *   dual      write sqlite (awaited) THEN kick off a fire-and-forget
   *             flashback write. Returns the sqlite id; the flashback write's
   *             success/failure never reaches the caller.
   *   flashback write flashback (awaited, authoritative id) AND shadow-write
   *             sqlite. If flashback throws, fall back to the sqlite id so the
   *             turn still records.
   */
  async record(rec: RawRecordInput): Promise<{ id: string }> {
    if (this.mode === 'sqlite' || !this.flashback) {
      return this.sqlite.record(rec);
    }
    if (this.mode === 'dual') {
      const local = await this.sqlite.record(rec);
      const key = `${rec.scope.user_id}:${rec.scope.thread_id ?? ''}`;
      this.fireAndForgetOrdered('record', key, () => this.flashback!.record(rec));
      return local;
    }
    // flashback authoritative: shadow sqlite (awaited so the backstop is real),
    // then take flashback's id when it answers; fall back to sqlite on failure.
    const local = await this.sqlite.record(rec);
    try {
      return await withTimeout(this.flashback.record(rec), this.ffTimeoutMs);
    } catch (err) {
      logger.warn('memory.flashback-record-failed', { err: msg(err) });
      return local;
    }
  }

  /**
   * The retrieval seam. sqlite/dual read the on-box store (the static-RAG path
   * ritsu has always used). flashback reads the smart store, falling back to
   * the sqlite copy if the remote read throws — a turn always gets SOME context.
   */
  async getContext(scope: Scope, query: string, opts?: { budget?: number; limit?: number }): Promise<AssembledContext> {
    if (this.mode !== 'flashback' || !this.flashback) {
      return this.sqlite.getContext(scope, query, opts);
    }
    try {
      return await withTimeout(this.flashback.getContext(scope, query, opts), this.ffTimeoutMs);
    } catch (err) {
      logger.warn('memory.flashback-context-failed', { err: msg(err) });
      return this.sqlite.getContext(scope, query, opts);
    }
  }

  /** Structured reads route to the active reader, sqlite-backstopped. */
  async query(scope: Scope, filter?: QueryFilter): Promise<RawRecord[]> {
    if (this.mode !== 'flashback' || !this.flashback) return this.sqlite.query(scope, filter);
    try {
      return await withTimeout(this.flashback.query(scope, filter), this.ffTimeoutMs);
    } catch (err) {
      logger.warn('memory.flashback-query-failed', { err: msg(err) });
      return this.sqlite.query(scope, filter);
    }
  }

  async read(id: string): Promise<RawRecord | null> {
    try {
      return await this.reader.read(id);
    } catch (err) {
      // Same backstop the context/query reads get: a remote outage degrades to
      // the local shadow copy rather than failing the turn.
      logger.warn('memory.flashback-read-failed', { err: msg(err) });
      return this.sqlite.read(id);
    }
  }

  async lineage(id: string): Promise<RawRecord[]> {
    try {
      return await this.reader.lineage(id);
    } catch (err) {
      logger.warn('memory.flashback-lineage-failed', { err: msg(err) });
      return this.sqlite.lineage(id);
    }
  }

  /** Turns in one thread must reach the store in order: the chain links each
   *  record to the previous one, so an out-of-order write cannot resolve its
   *  parent. Different threads still run concurrently.
   *
   *  Ordering waits on the REQUEST settling, not on our timeout — a timeout
   *  only stops us waiting, it does not stop the write, so releasing the chain
   *  there would put two writes for one thread in flight at once. The request
   *  is bounded by its own AbortSignal, so it always settles. */
  private fireAndForgetOrdered(op: string, key: string, fn: () => Promise<unknown>): void {
    const run = (): Promise<void> => {
      const underlying = Promise.resolve().then(fn);
      withTimeout(underlying, this.ffTimeoutMs).catch(err => {
        logger.warn('memory.flashback-fire-and-forget-failed', { op, err: msg(err) });
      });
      return underlying.then(
        () => undefined,
        () => undefined,
      );
    };
    const prev = this.writeChains.get(key) ?? Promise.resolve();
    const next = prev.then(run, run).finally(() => {
      if (this.writeChains.get(key) === next) this.writeChains.delete(key);
    });
    this.writeChains.set(key, next);
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
