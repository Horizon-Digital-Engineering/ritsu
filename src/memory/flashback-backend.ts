/**
 * Flashback adapter for the MemoryBackend seam. This is the class that turns an
 * in-process `memory.getContext(...)` call into a REST/network hop to a remote
 * flashback server. Nothing above this class knows a network is involved.
 *
 * Untested against a live flashback here (needs a running flashback + Postgres);
 * the contract matches the flashback REST API. `record` should be called
 * fire-and-forget by the host; reads should time out and fall back to sqlite.
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

export class FlashbackMemoryBackend implements MemoryBackend {
  constructor(private readonly cfg: FlashbackConfig) {}

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.token}` };
  }

  private signal(): AbortSignal {
    return AbortSignal.timeout(this.cfg.timeoutMs ?? 5000);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.endpoint}${path}`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: this.signal(),
    });
    if (!res.ok) throw new Error(`flashback POST ${path} -> ${res.status}`);
    return res.json() as Promise<T>;
  }

  async record(rec: RawRecordInput): Promise<{ id: string }> {
    return this.post('/records', rec);
  }

  async getContext(
    scope: Scope, query: string, opts: { budget?: number; limit?: number } = {},
  ): Promise<AssembledContext> {
    return this.post('/context/assemble', { scope, query, ...opts });
  }

  async query(scope: Scope, filter: QueryFilter = {}): Promise<RawRecord[]> {
    return this.post('/records/query', { scope, filter });
  }

  async read(id: string): Promise<RawRecord | null> {
    const res = await fetch(`${this.cfg.endpoint}/records/${encodeURIComponent(id)}`, {
      headers: this.headers(), signal: this.signal(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`flashback GET /records/${id} -> ${res.status}`);
    return res.json() as Promise<RawRecord>;
  }

  async lineage(id: string): Promise<RawRecord[]> {
    const res = await fetch(`${this.cfg.endpoint}/lineage/${encodeURIComponent(id)}`, {
      headers: this.headers(), signal: this.signal(),
    });
    if (!res.ok) throw new Error(`flashback GET /lineage/${id} -> ${res.status}`);
    return res.json() as Promise<RawRecord[]>;
  }
}
