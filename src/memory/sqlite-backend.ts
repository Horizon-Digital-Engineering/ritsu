/**
 * Local sqlite adapter for the MemoryBackend seam. Runs entirely on-box (no
 * network). This is ritsu's standalone / lite mode AND the resilient backstop
 * when flashback is unreachable.
 *
 * Immutability is enforced by construction: this class only ever INSERTs into
 * raw_records — never UPDATE, never DELETE. "Superseded" is a DERIVED status
 * (does any newer row point at me via `supersedes`?), so the old row is never
 * touched. That is what keeps curation deterministically rebuildable.
 *
 * getContext() is deliberately dumb here (keyword + recency) — the refineable
 * "fill". Flashback provides the smart, relevance-ranked version behind the same
 * seam; nothing above this class changes when you swap them.
 */
import { randomUUID, createHash } from 'node:crypto';
import type { Db } from '../db.js';
import { logger } from '../util/log.js';
import type {
  MemoryBackend, RawRecord, RawRecordInput, Scope, QueryFilter, AssembledContext, MemType,
} from './backend.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS raw_records (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  event_time    INTEGER NOT NULL,
  ingest_time   INTEGER NOT NULL,
  source        TEXT NOT NULL,
  source_ref    TEXT,
  user_id       TEXT NOT NULL,
  project_id    TEXT,
  thread_id     TEXT,
  mode          TEXT,
  supersedes    TEXT,
  prev_source_ref TEXT,
  acl           TEXT,
  ttl           INTEGER,
  payload       TEXT
);
CREATE INDEX IF NOT EXISTS raw_records_scope_type ON raw_records (user_id, project_id, type);
CREATE INDEX IF NOT EXISTS raw_records_event_time ON raw_records (event_time);
CREATE INDEX IF NOT EXISTS raw_records_ingest_time ON raw_records (ingest_time);
CREATE INDEX IF NOT EXISTS raw_records_thread ON raw_records (thread_id);
CREATE INDEX IF NOT EXISTS raw_records_mode ON raw_records (mode);
CREATE INDEX IF NOT EXISTS raw_records_hash ON raw_records (content_hash);
CREATE INDEX IF NOT EXISTS raw_records_supersedes ON raw_records (supersedes);
`;

/** DB row shape (TEXT/INTEGER/REAL/null), pre-parse. */
interface RawRow {
  id: string; type: string; content: string; content_hash: string;
  event_time: number; ingest_time: number; source: string; source_ref: string | null;
  user_id: string; project_id: string | null; thread_id: string | null; mode: string | null;
  prev_source_ref: string | null;
  importance: number | null; supersedes: string | null; acl: string | null;
  ttl: number | null; payload: string | null;
}

function rowToRecord(r: RawRow): RawRecord {
  return {
    id: r.id, type: r.type as MemType, content: r.content, content_hash: r.content_hash,
    event_time: r.event_time, ingest_time: r.ingest_time, source: r.source,
    source_ref: r.source_ref, user_id: r.user_id, project_id: r.project_id,
    thread_id: r.thread_id, mode: r.mode, supersedes: r.supersedes,
    prev_source_ref: r.prev_source_ref,
    acl: r.acl != null ? JSON.parse(r.acl) : null,
    ttl: r.ttl, payload: r.payload != null ? JSON.parse(r.payload) : null,
  };
}

function scopeClause(scope: Scope): { sql: string; args: (string)[] } {
  const clauses = ['user_id = ?'];
  const args: string[] = [scope.user_id];
  if (scope.project_id != null) { clauses.push('project_id = ?'); args.push(scope.project_id); }
  if (scope.thread_id != null) { clauses.push('thread_id = ?'); args.push(scope.thread_id); }
  if (scope.mode != null) { clauses.push('mode = ?'); args.push(scope.mode); }
  return { sql: clauses.join(' AND '), args };
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** Lite-mode getContext bounds its candidate fetch (most-recent N) to avoid an
 *  unbounded scan + full JS sort. The smart, unbounded path is flashback's job. */
export const LITE_CANDIDATE_CAP = 500;

/** `CREATE TABLE IF NOT EXISTS` skips a table that already exists, so a
 *  column rename in SCHEMA never reaches a live mirror — the indexes below it
 *  then fail on the missing column and the process dies at construction.
 *  Rename in place first. Delete once no database predates the rename. */
function renameLegacyColumns(db: Db): void {
  const cols = (db.prepare('PRAGMA table_info(raw_records)').all() as Array<{ name: string }>)
    .map(c => c.name);
  if (cols.length === 0) return;                                   // fresh install
  if (cols.includes('thread_id')) return;
  if (cols.includes('session_id')) {
    db.exec('ALTER TABLE raw_records RENAME COLUMN session_id TO thread_id');
    logger.info('memory.sqlite.renamed-session-id');
  } else if (cols.includes('container_id')) {
    db.exec('ALTER TABLE raw_records RENAME COLUMN container_id TO thread_id');
    logger.info('memory.sqlite.renamed-container-id');
  }
}

function addPrevSourceRefColumn(db: Db): void {
  const cols = (db.prepare('PRAGMA table_info(raw_records)').all() as Array<{ name: string }>)
    .map(c => c.name);
  if (cols.length === 0 || cols.includes('prev_source_ref')) return;
  db.exec('ALTER TABLE raw_records ADD COLUMN prev_source_ref TEXT');
  logger.info('memory.sqlite.added-prev-source-ref');
}

export class SqliteMemoryBackend implements MemoryBackend {
  constructor(private readonly db: Db) {
    renameLegacyColumns(this.db);
    addPrevSourceRefColumn(this.db);
    this.db.exec(SCHEMA);
  }

  async record(rec: RawRecordInput): Promise<{ id: string }> {
    const id = randomUUID();
    const now = nowSec();
    // sha256 to match flashback's content_hash so the hash agrees across backends.
    const content_hash = createHash('sha256').update(rec.content).digest('hex');
    this.db.prepare(
      `INSERT INTO raw_records
        (id, type, content, content_hash, event_time, ingest_time, source, source_ref,
         user_id, project_id, thread_id, mode, supersedes, prev_source_ref,
         acl, ttl, payload)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id, rec.type, rec.content, content_hash, rec.event_time ?? now, now, rec.source,
      rec.source_ref ?? null, rec.scope.user_id, rec.scope.project_id ?? null,
      rec.scope.thread_id ?? null, rec.scope.mode ?? null,
      rec.supersedes ?? null, rec.prev_source_ref ?? null,
      rec.acl != null ? JSON.stringify(rec.acl) : null,
      rec.ttl ?? null, rec.payload != null ? JSON.stringify(rec.payload) : null,
    );
    return { id };
  }

  async query(scope: Scope, filter: QueryFilter = {}): Promise<RawRecord[]> {
    const { sql: scopeSql, args } = scopeClause(scope);
    let sql =
      `SELECT * FROM raw_records
       WHERE ${scopeSql}
         AND id NOT IN (SELECT supersedes FROM raw_records WHERE supersedes IS NOT NULL)
         AND (ttl IS NULL OR ttl > ?)`;
    const qargs: (string | number)[] = [...args, nowSec()];
    if (filter.type) { sql += ' AND type = ?'; qargs.push(filter.type); }
    if (filter.since != null) { sql += ' AND event_time >= ?'; qargs.push(filter.since); }
    if (filter.until != null) { sql += ' AND event_time <= ?'; qargs.push(filter.until); }
    sql += ' ORDER BY event_time DESC';
    if (filter.limit != null) { sql += ' LIMIT ?'; qargs.push(filter.limit); }
    return (this.db.prepare(sql).all(...qargs) as RawRow[]).map(rowToRecord);
  }

  async getContext(
    scope: Scope, query: string, opts: { budget?: number; limit?: number } = {},
  ): Promise<AssembledContext> {
    const limit = opts.limit ?? 50;
    const candidates = await this.query(scope, { limit: LITE_CANDIDATE_CAP });
    // De-duped query terms, matched at WORD boundaries (so "at" doesn't hit
    // "cat" and a repeated term can't inflate the score).
    const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
    const scored = candidates.map(r => {
      const words = new Set(r.content.toLowerCase().split(/\W+/).filter(Boolean));
      const score = terms.reduce((s, t) => s + (words.has(t) ? 1 : 0), 0);
      return { r, score };
    });
    scored.sort((a, b) => b.score - a.score || b.r.event_time - a.r.event_time);
    return { records: scored.slice(0, limit).map(x => x.r) };
  }

  async read(id: string): Promise<RawRecord | null> {
    const row = this.db.prepare('SELECT * FROM raw_records WHERE id = ?').get(id) as RawRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  async lineage(id: string): Promise<RawRecord[]> {
    const seen = new Map<string, RawRecord>();
    const start = await this.read(id);
    if (!start) return [];
    seen.set(start.id, start);
    // walk older via the forward pointer
    let cur: RawRecord | null = start;
    while (cur?.supersedes) {
      const older: RawRecord | null = await this.read(cur.supersedes);
      if (!older || seen.has(older.id)) break;
      seen.set(older.id, older);
      cur = older;
    }
    // walk newer (rows that supersede anything we've seen)
    let added = true;
    while (added) {
      added = false;
      for (const rid of [...seen.keys()]) {
        // .all(): a branch has MULTIPLE rows superseding the same id; .get()
        // would grab only one and silently drop the siblings.
        const newers = this.db.prepare('SELECT * FROM raw_records WHERE supersedes = ?').all(rid) as RawRow[];
        for (const newer of newers) {
          if (!seen.has(newer.id)) { seen.set(newer.id, rowToRecord(newer)); added = true; }
        }
      }
    }
    // order oldest -> newest by WALKING the chain (deterministic; ingest_time is
    // second-resolution so it can't be the sort key).
    return orderChain([...seen.values()]);
  }
}

/** Order a set of supersede-linked records oldest-first. Emits EVERY node —
 *  a topological sort over the supersede edges (a node comes after the one it
 *  supersedes), so branched/multi-head histories keep all versions instead of
 *  the linear walk dropping siblings. Tie-breaks by ingest_time; cycle-safe. */
export function orderChain(nodes: RawRecord[]): RawRecord[] {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const remaining = new Set(nodes.map(n => n.id));
  const out: RawRecord[] = [];
  const oldestFirst = (a: RawRecord, b: RawRecord) =>
    a.ingest_time - b.ingest_time || a.id.localeCompare(b.id);
  while (remaining.size) {
    const ready = [...remaining]
      .map(id => byId.get(id)!)
      .filter(n => n.supersedes == null || !remaining.has(n.supersedes)) // predecessor emitted or external
      .sort(oldestFirst);
    if (ready.length === 0) {
      // supersede cycle — emit the rest deterministically instead of looping.
      out.push(...[...remaining].map(id => byId.get(id)!).sort(oldestFirst));
      break;
    }
    out.push(ready[0]);
    remaining.delete(ready[0].id);
  }
  return out;
}
