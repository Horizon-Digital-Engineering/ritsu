/**
 * In-memory MemoryBackend — for tests and for consumer code that wants a store
 * with zero deps (no DB, no network). Mirrors SqliteMemoryBackend semantics:
 * append-only, supersede-as-forward-pointer, ttl expiry, scope filtering.
 */
import { randomUUID, createHash } from 'node:crypto';
import { orderChain, LITE_CANDIDATE_CAP } from './sqlite-backend.js';
import type {
  MemoryBackend, RawRecord, RawRecordInput, Scope, QueryFilter, AssembledContext,
} from './backend.js';

const nowSec = () => Math.floor(Date.now() / 1000);

export class FakeMemoryBackend implements MemoryBackend {
  private readonly rows: RawRecord[] = [];

  async record(rec: RawRecordInput): Promise<{ id: string }> {
    const id = randomUUID();
    const now = nowSec();
    this.rows.push({
      id, type: rec.type, content: rec.content,
      content_hash: createHash('sha256').update(rec.content).digest('hex'),
      event_time: rec.event_time ?? now, ingest_time: now, source: rec.source,
      source_ref: rec.source_ref ?? null, user_id: rec.scope.user_id,
      project_id: rec.scope.project_id ?? null, thread_id: rec.scope.thread_id ?? null,
      mode: rec.scope.mode ?? null,
      supersedes: rec.supersedes ?? null,
      prev_source_ref: rec.prev_source_ref ?? null,
      // JSON round-trip so acl/payload match sqlite's serialize-then-parse
      // semantics (drops undefined keys, NaN->null) and aren't stored by reference.
      acl: rec.acl != null ? JSON.parse(JSON.stringify(rec.acl)) : null,
      ttl: rec.ttl ?? null,
      payload: rec.payload != null ? JSON.parse(JSON.stringify(rec.payload)) : null,
    });
    return { id };
  }

  private active(scope: Scope): RawRecord[] {
    const now = nowSec();
    const superseded = new Set(this.rows.map(r => r.supersedes).filter((s): s is string => s != null));
    return this.rows.filter(r =>
      r.user_id === scope.user_id &&
      (scope.project_id == null || r.project_id === scope.project_id) &&
      (scope.thread_id == null || r.thread_id === scope.thread_id) &&
      (scope.mode == null || r.mode === scope.mode) &&
      !superseded.has(r.id) &&
      (r.ttl == null || r.ttl > now));
  }

  async getContext(
    scope: Scope, query: string, opts: { budget?: number; limit?: number } = {},
  ): Promise<AssembledContext> {
    const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
    // Memory means OTHER conversations — the live thread is excluded, matching
    // both real backends.
    const { thread_id: live, ...crossThread } = scope;
    const candidates = this.active(crossThread)
      .filter(r => live == null || r.thread_id !== live)
      .sort((a, b) => b.event_time - a.event_time)
      .slice(0, LITE_CANDIDATE_CAP);
    const scored = candidates.map(r => {
      const words = new Set(r.content.toLowerCase().split(/\W+/).filter(Boolean));
      return { r, score: terms.reduce((s, t) => s + (words.has(t) ? 1 : 0), 0) };
    });
    scored.sort((a, b) => b.score - a.score || b.r.event_time - a.r.event_time);
    return { records: scored.slice(0, opts.limit ?? 50).map(x => x.r) };
  }

  async query(scope: Scope, filter: QueryFilter = {}): Promise<RawRecord[]> {
    let rows = this.active(scope);
    if (filter.type) rows = rows.filter(r => r.type === filter.type);
    if (filter.since != null) rows = rows.filter(r => r.event_time >= filter.since!);
    if (filter.until != null) rows = rows.filter(r => r.event_time <= filter.until!);
    rows = [...rows].sort((a, b) => b.event_time - a.event_time);
    return filter.limit != null ? rows.slice(0, filter.limit) : rows;
  }

  async read(id: string): Promise<RawRecord | null> {
    return this.rows.find(r => r.id === id) ?? null;
  }

  async lineage(id: string): Promise<RawRecord[]> {
    const seen = new Map<string, RawRecord>();
    let cur = this.rows.find(r => r.id === id);
    if (!cur) return [];
    seen.set(cur.id, cur);
    while (cur?.supersedes) {
      const older = this.rows.find(r => r.id === cur!.supersedes);
      if (!older || seen.has(older.id)) break;
      seen.set(older.id, older);
      cur = older;
    }
    let added = true;
    while (added) {
      added = false;
      for (const rid of [...seen.keys()]) {
        // .filter(): a branch has multiple rows superseding the same id; .find()
        // would grab only one and silently drop the siblings.
        for (const newer of this.rows.filter(r => r.supersedes === rid)) {
          if (!seen.has(newer.id)) { seen.set(newer.id, newer); added = true; }
        }
      }
    }
    return orderChain([...seen.values()]);
  }
}
