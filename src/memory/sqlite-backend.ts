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
  session_id    TEXT,
  mode          TEXT,
  importance    REAL,
  supersedes    TEXT,
  acl           TEXT,
  ttl           INTEGER,
  payload       TEXT
);
CREATE INDEX IF NOT EXISTS raw_records_scope_type ON raw_records (user_id, project_id, type);
CREATE INDEX IF NOT EXISTS raw_records_event_time ON raw_records (event_time);
CREATE INDEX IF NOT EXISTS raw_records_ingest_time ON raw_records (ingest_time);
CREATE INDEX IF NOT EXISTS raw_records_session ON raw_records (session_id);
CREATE INDEX IF NOT EXISTS raw_records_mode ON raw_records (mode);
CREATE INDEX IF NOT EXISTS raw_records_hash ON raw_records (content_hash);
CREATE INDEX IF NOT EXISTS raw_records_supersedes ON raw_records (supersedes);
`;

/** DB row shape (TEXT/INTEGER/REAL/null), pre-parse. */
interface RawRow {
  id: string; type: string; content: string; content_hash: string;
  event_time: number; ingest_time: number; source: string; source_ref: string | null;
  user_id: string; project_id: string | null; session_id: string | null; mode: string | null;
  importance: number | null; supersedes: string | null; acl: string | null;
  ttl: number | null; payload: string | null;
}

function rowToRecord(r: RawRow): RawRecord {
  return {
    id: r.id, type: r.type as MemType, content: r.content, content_hash: r.content_hash,
    event_time: r.event_time, ingest_time: r.ingest_time, source: r.source,
    source_ref: r.source_ref, user_id: r.user_id, project_id: r.project_id,
    session_id: r.session_id, mode: r.mode, importance: r.importance, supersedes: r.supersedes,
    acl: r.acl != null ? JSON.parse(r.acl) : null,
    ttl: r.ttl, payload: r.payload != null ? JSON.parse(r.payload) : null,
  };
}

function scopeClause(scope: Scope): { sql: string; args: (string)[] } {
  const clauses = ['user_id = ?'];
  const args: string[] = [scope.user_id];
  if (scope.project_id != null) { clauses.push('project_id = ?'); args.push(scope.project_id); }
  if (scope.session_id != null) { clauses.push('session_id = ?'); args.push(scope.session_id); }
  if (scope.mode != null) { clauses.push('mode = ?'); args.push(scope.mode); }
  return { sql: clauses.join(' AND '), args };
}

const nowSec = () => Math.floor(Date.now() / 1000);

export class SqliteMemoryBackend implements MemoryBackend {
  constructor(private readonly db: Db) {
    this.db.exec(SCHEMA);
  }

  async record(rec: RawRecordInput): Promise<{ id: string }> {
    const id = randomUUID();
    const now = nowSec();
    const content_hash = createHash('sha256').update(rec.content).digest('hex');
    this.db.prepare(
      `INSERT INTO raw_records
        (id, type, content, content_hash, event_time, ingest_time, source, source_ref,
         user_id, project_id, session_id, mode, importance, supersedes, acl, ttl, payload)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id, rec.type, rec.content, content_hash, rec.event_time ?? now, now, rec.source,
      rec.source_ref ?? null, rec.scope.user_id, rec.scope.project_id ?? null,
      rec.scope.session_id ?? null, rec.scope.mode ?? null, rec.importance ?? null,
      rec.supersedes ?? null, rec.acl != null ? JSON.stringify(rec.acl) : null,
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
    const all = await this.query(scope, {});
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = all.map(r => {
      const c = r.content.toLowerCase();
      const score = terms.reduce((s, t) => s + (c.includes(t) ? 1 : 0), 0);
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
        const newer = this.db.prepare('SELECT * FROM raw_records WHERE supersedes = ?').get(rid) as RawRow | undefined;
        if (newer && !seen.has(newer.id)) { seen.set(newer.id, rowToRecord(newer)); added = true; }
      }
    }
    // order oldest -> newest by WALKING the chain (deterministic; ingest_time is
    // second-resolution so it can't be the sort key).
    return orderChain([...seen.values()]);
  }
}

/** Order a set of supersede-linked records oldest-first by chain structure. */
export function orderChain(nodes: RawRecord[]): RawRecord[] {
  const byId = new Map(nodes.map(n => [n.id, n]));
  let cur: RawRecord | undefined = nodes.find(n => n.supersedes == null || !byId.has(n.supersedes)) ?? nodes[0];
  const ordered: RawRecord[] = [];
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    ordered.push(cur);
    cur = nodes.find(n => n.supersedes === cur!.id);
  }
  return ordered;
}
