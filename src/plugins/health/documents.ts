/**
 * Dumped source documents (benefits/SBC, lab reports, discharge notes, …) kept
 * as raw text so the assistant can quote the ACTUAL language, not just the
 * structured fields we extracted. A structured benefit answers "specialist =
 * $50 copay"; the raw doc answers the long tail ("does my plan cover
 * acupuncture?") that no table captured. Keyword search for now; the shared
 * ingestion core (original-file storage + vision extract + FTS/embeddings)
 * generalizes this across every plugin later.
 */
import type { PluginDb } from '../types.js';

export interface HealthDocument {
  id: number;
  category: string;       // 'benefits' | 'lab_report' | 'eob' | 'note' | …
  title: string;
  source: string;         // 'paste' | 'photo' | 'apple_export' | …
  text: string;
  ref_type: string;       // '' | 'plan' | …
  ref_id: number | null;  // linked entity id (e.g. insurance plan)
  created_at: number;
}

export interface DocumentInput {
  category: string;
  title: string;
  text: string;
  source?: string;
  ref_type?: string;
  ref_id?: number | null;
}

export class DocumentStore {
  constructor(private readonly db: PluginDb) {}
  private get docs(): string { return this.db.table('documents'); }

  add(d: DocumentInput): number {
    return Number(this.db.prepare(
      `INSERT INTO ${this.docs} (category, title, source, text, ref_type, ref_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(d.category, d.title, d.source ?? 'paste', d.text, d.ref_type ?? '', d.ref_id ?? null).lastInsertRowid);
  }

  /** Metadata listing (never the full text — that can be large). */
  list(category?: string): Array<Omit<HealthDocument, 'text'> & { chars: number }> {
    const sql = `SELECT id, category, title, source, ref_type, ref_id, created_at, LENGTH(text) AS chars
                 FROM ${this.docs}${category ? ' WHERE category = ?' : ''} ORDER BY created_at DESC`;
    return (category ? this.db.prepare(sql).all(category) : this.db.prepare(sql).all()) as Array<Omit<HealthDocument, 'text'> & { chars: number }>;
  }

  all(): HealthDocument[] {
    return this.db.prepare(`SELECT * FROM ${this.docs} ORDER BY created_at DESC`).all() as HealthDocument[];
  }

  get(id: number): HealthDocument | null {
    return (this.db.prepare(`SELECT * FROM ${this.docs} WHERE id = ?`).get(id) as HealthDocument | undefined) ?? null;
  }

  delete(id: number): boolean {
    return this.db.prepare(`DELETE FROM ${this.docs} WHERE id = ?`).run(id).changes > 0;
  }
}

export interface DocHit { doc_id: number; title: string; category: string; snippet: string; score: number }

/** Rank passages of the dumped docs by how many query terms they contain — a
 *  lightweight stand-in for FTS until the ingestion core lands. Pure. */
export function searchDocuments(docs: HealthDocument[], query: string, limit = 4): DocHit[] {
  const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2))];
  if (!terms.length) return [];
  const hits: DocHit[] = [];
  for (const d of docs) {
    const passages = d.text.split(/\n\s*\n|(?<=[.?!])\s+(?=[A-Z])/).map(p => p.trim().replace(/\s+/g, ' ')).filter(Boolean);
    for (const p of passages) {
      const lc = p.toLowerCase();
      const score = terms.reduce((s, t) => s + (lc.includes(t) ? 1 : 0), 0);
      if (score > 0) hits.push({ doc_id: d.id, title: d.title, category: d.category, snippet: p.slice(0, 400), score });
    }
  }
  return hits.toSorted((a, b) => b.score - a.score).slice(0, limit);
}
