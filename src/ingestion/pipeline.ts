/**
 * Shared document-ingestion pipeline — the reusable core behind "dump a doc /
 * snap a photo → structured data lands in the right place." A composable
 * library (plugins import it over their own scoped DB), not a god-plugin.
 *
 * Flow:  submit(input, docType) → store the ORIGINAL + run the extractor →
 *        validate against the doc-type schema → hold as PENDING for review →
 *        confirm(id, edits?) routes the (human-approved) data to the domain →
 *        committed. reject(id) drops it. The original is kept either way.
 *
 * The extractor (vision/LLM) is injected, so this is fully testable with a
 * static extractor and the real model call wires in without touching the flow.
 */
import type { ZodType } from 'zod';
import type { PluginDb } from '../plugins/types.js';

export type IngestStatus = 'pending' | 'committed' | 'rejected' | 'error';

export interface ExtractInput {
  title: string;
  source: string;               // 'paste' | 'upload' | 'photo' | 'apple_export'
  text?: string;
  imageBase64?: string;
  mediaType?: string;           // e.g. 'image/png'
}

/** A domain plugin describes each kind of document it can ingest. */
export interface DocType<T = unknown> {
  id: string;                   // 'sbc' | 'lab_report' | …
  label: string;
  schema: ZodType<T>;           // shape the extractor must produce
  /** Guidance handed to the extractor about what to pull out. */
  instructions: string;
  /** Route the reviewed, validated data into the domain's own tables. `record`
   *  gives the handler the original + metadata (e.g. to also keep the raw doc
   *  searchable). */
  commit(data: T, ctx: { ingestionId: number; record: IngestionRecord }): void;
}

export interface Extractor {
  extract(input: ExtractInput, docType: DocType): Promise<unknown>;
}

export interface IngestionRecord {
  id: number;
  doc_type: string;
  status: IngestStatus;
  title: string;
  source: string;
  media_type: string;
  original: string;             // raw text, or base64 for an image
  extracted: string | null;     // candidate structured JSON (pre-commit)
  error: string | null;
  created_at: number;
  committed_at: number | null;
}

interface Row extends Omit<IngestionRecord, never> { id: number }

export function migrateIngestion(db: PluginDb): void {
  const t = db.table('ingestions');
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${t} (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_type     TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      title        TEXT NOT NULL DEFAULT '',
      source       TEXT NOT NULL DEFAULT 'paste',
      media_type   TEXT NOT NULL DEFAULT 'text',
      original     TEXT NOT NULL DEFAULT '',
      extracted    TEXT,
      error        TEXT,
      created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      committed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_${t}_status ON ${t}(status);
  `);
}

export class IngestionStore {
  constructor(private readonly db: PluginDb) {}
  private get t(): string { return this.db.table('ingestions'); }

  create(r: { doc_type: string; title: string; source: string; media_type: string; original: string }): number {
    return Number(this.db.prepare(
      `INSERT INTO ${this.t} (doc_type, title, source, media_type, original) VALUES (?, ?, ?, ?, ?)`,
    ).run(r.doc_type, r.title, r.source, r.media_type, r.original).lastInsertRowid);
  }
  setExtracted(id: number, json: string): void {
    this.db.prepare(`UPDATE ${this.t} SET extracted = ?, status = 'pending', error = NULL WHERE id = ?`).run(json, id);
  }
  setError(id: number, error: string): void {
    this.db.prepare(`UPDATE ${this.t} SET status = 'error', error = ? WHERE id = ?`).run(error, id);
  }
  setStatus(id: number, status: IngestStatus): void {
    this.db.prepare(`UPDATE ${this.t} SET status = ? WHERE id = ?`).run(status, id);
  }
  setCommitted(id: number): void {
    this.db.prepare(`UPDATE ${this.t} SET status = 'committed', committed_at = strftime('%s','now') WHERE id = ?`).run(id);
  }
  get(id: number): IngestionRecord | null {
    return (this.db.prepare(`SELECT * FROM ${this.t} WHERE id = ?`).get(id) as Row | undefined) ?? null;
  }
  /** Listing omits the (possibly huge) original + extracted blobs. */
  list(status?: IngestStatus): Array<Omit<IngestionRecord, 'original' | 'extracted'>> {
    const sql = `SELECT id, doc_type, status, title, source, media_type, error, created_at, committed_at
                 FROM ${this.t}${status ? ' WHERE status = ?' : ''} ORDER BY created_at DESC`;
    return (status ? this.db.prepare(sql).all(status) : this.db.prepare(sql).all()) as Array<Omit<IngestionRecord, 'original' | 'extracted'>>;
  }
  delete(id: number): boolean {
    return this.db.prepare(`DELETE FROM ${this.t} WHERE id = ?`).run(id).changes > 0;
  }
}

export class IngestionPipeline {
  private readonly types = new Map<string, DocType>();
  constructor(private readonly store: IngestionStore, private readonly extractor: Extractor) {}

  registerType(t: DocType): this { this.types.set(t.id, t); return this; }
  docTypes(): Array<{ id: string; label: string }> {
    return [...this.types.values()].map(t => ({ id: t.id, label: t.label }));
  }

  /** Store the original, extract + validate, hold as pending (or mark error). */
  async submit(input: ExtractInput, docTypeId: string): Promise<IngestionRecord> {
    const t = this.types.get(docTypeId);
    if (!t) throw new Error(`unknown document type '${docTypeId}'`);
    const id = this.store.create({
      doc_type: docTypeId, title: input.title, source: input.source,
      media_type: input.mediaType ?? 'text', original: input.text ?? input.imageBase64 ?? '',
    });
    try {
      const raw = await this.extractor.extract(input, t);
      const parsed = t.schema.parse(raw);
      this.store.setExtracted(id, JSON.stringify(parsed));
    } catch (e) {
      this.store.setError(id, (e as Error).message);
    }
    return this.store.get(id)!;
  }

  /** Human-in-the-loop commit: route the reviewed data to the domain. `edited`
   *  (from the confirm UI) overrides the extractor's candidate when present. */
  confirm(id: number, edited?: unknown): IngestionRecord {
    const rec = this.store.get(id);
    if (!rec) throw new Error(`ingestion ${id} not found`);
    const t = this.types.get(rec.doc_type);
    if (!t) throw new Error(`unknown document type '${rec.doc_type}'`);
    const source: unknown = edited ?? (rec.extracted ? JSON.parse(rec.extracted) : undefined);
    if (source === undefined) throw new Error('nothing to commit — no extracted data');
    const data = t.schema.parse(source);
    t.commit(data, { ingestionId: id, record: rec });
    this.store.setCommitted(id);
    return this.store.get(id)!;
  }

  reject(id: number): void { this.store.setStatus(id, 'rejected'); }
}
