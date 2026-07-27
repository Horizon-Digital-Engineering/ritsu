/**
 * SEAM 2 — the MemoryBackend interface (the consumer<->store seam).
 *
 * An in-process interface, NOT a network call. Ritsu's code always calls these
 * methods; the ADAPTER behind them decides what happens:
 *   - SqliteMemoryBackend    -> local SQL on this box (no network)
 *   - FlashbackMemoryBackend -> HTTP/REST to flashback (network hop)
 *   - FakeMemoryBackend      -> in-memory (tests)
 *
 * Everything is a typed RawRecord (not conversation-shaped): a chat turn, a fact,
 * a transaction, a lab result, an event. Raw is immutable — corrections are a NEW
 * record with `supersedes` set; the old row is never mutated.
 */

/**
 * HOW A RECORD MUST BE PROCESSED — never a memory tier, never what it's about.
 * `episodic` and `semantic` are tiers the store's curation pipeline DERIVES; a
 * writer claiming one asserts an outcome it hasn't earned, and flashback
 * rejects it. Only types with a real extractor exist; more land with theirs.
 */
export type MemType = 'conversation' | 'document' | 'state_object';

export interface Scope {
  user_id: string;
  /**
   * A HARD PARTITION: curation never derives across it, so records in different
   * projects can never be clustered or distilled together. Reserve it for
   * genuinely separate bodies of work. A grouping that is really just a sorter —
   * an agent name, a chat folder — belongs in `payload`.
   */
  project_id?: string | null;
  /**
   * The stream this arrived on — a chat thread, a watched folder, an import
   * batch. Episodes form per container. Namespace it: it has to stay unique
   * across every writer, not just this one.
   */
  container_id?: string | null;
  mode?: string | null;
}

/** What a consumer writes. Same shape to sqlite (lite) and flashback (full). */
export interface RawRecordInput {
  type: MemType;
  content: string;
  /** epoch seconds when it ACTUALLY happened; defaults to ingest time. */
  event_time?: number;
  source: string;
  source_ref?: string | null;
  scope: Scope;
  importance?: number | null;
  /** id of the record this one supersedes (forward pointer; old row untouched). */
  supersedes?: string | null;
  acl?: unknown;
  /** epoch seconds expiry; omit to keep forever. */
  ttl?: number | null;
  /** Metadata we already have at capture time, verbatim and uninterpreted —
   *  which agent, which model, which folder. The store reads it during
   *  derivation; nothing here is a claim about what the record MEANS. */
  payload?: unknown;
}

export interface RawRecord {
  id: string;
  type: MemType;
  content: string;
  content_hash: string;
  event_time: number;
  ingest_time: number;
  source: string;
  source_ref: string | null;
  user_id: string;
  project_id: string | null;
  container_id: string | null;
  mode: string | null;
  importance: number | null;
  supersedes: string | null;
  acl: unknown;
  ttl: number | null;
  payload: unknown;
}

export interface AssembledContext {
  records: RawRecord[];
  /** curated view (full mode only). */
  summaries?: string[];
  /** token accounting (full mode). */
  tokens?: number;
}

export interface QueryFilter {
  type?: MemType;
  /** event_time >= since (epoch seconds). */
  since?: number;
  /** event_time <= until (epoch seconds). */
  until?: number;
  limit?: number;
}

export interface MemoryBackend {
  /** The dump. Append-only; returns the new record id. */
  record(rec: RawRecordInput): Promise<{ id: string }>;
  /** The ask — query-driven relevant context (this is the retrieval seam). */
  getContext(scope: Scope, query: string, opts?: { budget?: number; limit?: number }): Promise<AssembledContext>;
  /** Structured reads for dashboards. */
  query(scope: Scope, filter?: QueryFilter): Promise<RawRecord[]>;
  /** A single record by id (includes superseded ones — for inspection/lineage). */
  read(id: string): Promise<RawRecord | null>;
  /** The full supersede chain for a record, oldest-first. */
  lineage(id: string): Promise<RawRecord[]>;
}
