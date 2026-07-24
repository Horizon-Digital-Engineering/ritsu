/**
 * Flashback adapter for the MemoryBackend seam — turns in-process calls into
 * REST/network hops to a remote flashback server, and maps between the seam's
 * epoch-seconds `RawRecord` shape and flashback's FLAT, RFC3339 request/response
 * contract (the `/records` endpoints: bodies are flat with project/session/mode
 * at top level, user_id comes from the token, timestamps are RFC3339).
 *
 * Errors are surfaced (throws on network failure / non-2xx) — the adapter does
 * NOT silently swallow. The HOST owns the resilience pattern: wrap `record()`
 * fire-and-forget (`.catch()`), and fall back to the sqlite backend when
 * `getContext` throws. That keeps real failures visible instead of turning them
 * into an unhandled rejection or a silent no-op.
 */
import type {
  MemoryBackend, RawRecord, RawRecordInput, Scope, QueryFilter, AssembledContext,
} from './backend.js';

export interface FlashbackConfig {
  /** e.g. https://<flashback-host>:8080 */
  endpoint: string;
  token: string;
  timeoutMs?: number;
}

/** Loose shape of a flashback JSON record row (RFC3339 timestamps). */
type WireRow = Record<string, unknown>;

const nowSec = () => Math.floor(Date.now() / 1000);
const toIso = (epochSec: number) => new Date(epochSec * 1000).toISOString();
const fromIso = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Seam RawRecordInput -> flashback's flat IngestRecordRequest body. */
function toIngestBody(rec: RawRecordInput): Record<string, unknown> {
  const b: Record<string, unknown> = { type: rec.type, content: rec.content, source: rec.source };
  if (rec.event_time != null) b.event_time = toIso(rec.event_time);
  if (rec.source_ref != null) b.source_ref = rec.source_ref;
  if (rec.scope.project_id != null) b.project_id = rec.scope.project_id;
  if (rec.scope.session_id != null) b.session_id = rec.scope.session_id;
  if (rec.scope.mode != null) b.mode = rec.scope.mode;
  if (rec.importance != null) b.importance = rec.importance;
  if (rec.supersedes != null) b.supersedes = rec.supersedes;
  // seam ttl is an absolute epoch; flashback wants a relative ttl_hours.
  if (rec.ttl != null) b.ttl_hours = Math.ceil((rec.ttl - nowSec()) / 3600);
  if (rec.acl != null) b.acl = rec.acl;
  if (rec.payload != null) b.payload = rec.payload;
  return b;
}

/** flashback row (RFC3339 timestamps) -> seam RawRecord (epoch seconds). */
function fromRow(r: WireRow): RawRecord {
  return {
    id: String(r.id),
    type: String(r.type) as RawRecord['type'],
    content: String(r.content),
    content_hash: String(r.content_hash),
    event_time: fromIso(String(r.event_time)),
    ingest_time: fromIso(String(r.ingest_time)),
    source: String(r.source),
    source_ref: str(r.source_ref),
    user_id: String(r.user_id),
    project_id: str(r.project_id),
    session_id: str(r.session_id),
    mode: str(r.mode),
    importance: typeof r.importance === 'number' ? r.importance : null,
    supersedes: str(r.supersedes),
    acl: r.acl ?? null,
    ttl: typeof r.ttl === 'string' ? fromIso(r.ttl) : null,
    payload: r.payload ?? null,
  };
}

function scopeBody(scope: Scope): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  if (scope.project_id != null) b.project_id = scope.project_id;
  if (scope.session_id != null) b.session_id = scope.session_id;
  if (scope.mode != null) b.mode = scope.mode;
  return b;
}

export class FlashbackMemoryBackend implements MemoryBackend {
  constructor(private readonly cfg: FlashbackConfig) {}

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.token}` };
  }
  private signal(): AbortSignal { return AbortSignal.timeout(this.cfg.timeoutMs ?? 5000); }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.endpoint}${path}`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: this.signal(),
    });
    if (!res.ok) throw new Error(`flashback POST ${path} -> ${res.status}`);
    return res.json() as Promise<T>;
  }
  private async getJson(path: string): Promise<unknown> {
    const res = await fetch(`${this.cfg.endpoint}${path}`, { headers: this.headers(), signal: this.signal() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`flashback GET ${path} -> ${res.status}`);
    return res.json();
  }

  async record(rec: RawRecordInput): Promise<{ id: string }> {
    return this.post('/records', toIngestBody(rec));
  }

  async getContext(scope: Scope, query: string, opts: { budget?: number; limit?: number } = {}): Promise<AssembledContext> {
    const body = { ...scopeBody(scope), query, ...(opts.limit != null ? { limit: opts.limit } : {}) };
    const res = await this.post<{ records?: WireRow[] }>('/records/context', body);
    return { records: (res.records ?? []).map(fromRow) };
  }

  async query(scope: Scope, filter: QueryFilter = {}): Promise<RawRecord[]> {
    const body: Record<string, unknown> = scopeBody(scope);
    if (filter.type != null) body.type = filter.type;
    if (filter.since != null) body.since = toIso(filter.since);
    if (filter.until != null) body.until = toIso(filter.until);
    if (filter.limit != null) body.limit = filter.limit;
    const rows = await this.post<WireRow[]>('/records/query', body);
    return (rows ?? []).map(fromRow);
  }

  async read(id: string): Promise<RawRecord | null> {
    const row = await this.getJson(`/records/${encodeURIComponent(id)}`);
    return row ? fromRow(row as WireRow) : null;
  }

  async lineage(id: string): Promise<RawRecord[]> {
    const rows = (await this.getJson(`/records/${encodeURIComponent(id)}/lineage`)) as WireRow[] | null;
    return (rows ?? []).map(fromRow);
  }
}
