/**
 * Health plugin data access over scoped tables (plugin_health_*). Two spines:
 *   - observations: a unified numeric time-series (weight, a lab marker, a
 *     vital, …) so everything lands on one timeline and can be trended +
 *     correlated. One row = one measurement of one `label` on one `date`.
 *   - medications: the current + past med list, with start/stop so meds land
 *     on the same timeline as the observations they might move.
 */
import type { PluginDb } from '../types.js';

export interface Observation {
  id: number;
  date: string;          // YYYY-MM-DD
  kind: string;          // 'weight' | 'lab' | 'vital' | 'other'
  label: string;         // 'Weight' | 'LDL' | 'BP Systolic' | …
  value: number;
  unit: string;
  ref_low: number | null;
  ref_high: number | null;
  flag: string;          // 'low' | 'normal' | 'high' | ''
  source: string;        // 'manual' | 'photo' | 'import'
  note: string;
  created_at: number;
}

export interface Medication {
  id: number;
  name: string;
  dose: string;
  frequency: string;
  route: string;
  start_date: string;
  end_date: string | null;
  active: boolean;
  prescriber: string;
  rx_number: string;
  pharmacy: string;
  note: string;
  created_at: number;
  updated_at: number;
}

interface ObsRow extends Omit<Observation, never> { id: number }
interface MedRow extends Omit<Medication, 'active'> { active: number }

const toMed = (r: MedRow): Medication => ({ ...r, active: r.active === 1 });

export interface ObservationInput {
  date: string;
  kind: string;
  label: string;
  value: number;
  unit?: string;
  ref_low?: number | null;
  ref_high?: number | null;
  source?: string;
  note?: string;
}

export interface MedicationInput {
  name: string;
  dose?: string;
  frequency?: string;
  route?: string;
  start_date?: string;
  end_date?: string | null;
  prescriber?: string;
  rx_number?: string;
  pharmacy?: string;
  note?: string;
}

/** Derived out-of-range flag when a ref range is known. */
function flagFor(value: number, low: number | null | undefined, high: number | null | undefined): string {
  if (low != null && value < low) return 'low';
  if (high != null && value > high) return 'high';
  if (low != null || high != null) return 'normal';
  return '';
}

export class HealthStore {
  constructor(private readonly db: PluginDb) {}

  private get obs(): string { return this.db.table('observations'); }
  private get meds(): string { return this.db.table('medications'); }

  // ---- observations -----------------------------------------------------
  addObservation(o: ObservationInput): number {
    const flag = flagFor(o.value, o.ref_low, o.ref_high);
    return Number(this.db.prepare(
      `INSERT INTO ${this.obs} (date, kind, label, value, unit, ref_low, ref_high, flag, source, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(o.date, o.kind, o.label, o.value, o.unit ?? '', o.ref_low ?? null, o.ref_high ?? null, flag, o.source ?? 'manual', o.note ?? '').lastInsertRowid);
  }

  /** Every observation for one label, oldest→newest (a time-series). */
  series(label: string): Observation[] {
    return this.db.prepare(`SELECT * FROM ${this.obs} WHERE label = ? ORDER BY date ASC, id ASC`).all(label) as ObsRow[];
  }

  recentObservations(label: string | undefined, limit = 50): Observation[] {
    const sql = label
      ? `SELECT * FROM ${this.obs} WHERE label = ? ORDER BY date DESC, id DESC LIMIT ?`
      : `SELECT * FROM ${this.obs} ORDER BY date DESC, id DESC LIMIT ?`;
    return (label ? this.db.prepare(sql).all(label, limit) : this.db.prepare(sql).all(limit)) as ObsRow[];
  }

  /** Distinct labels seen, with their kind + observation count. */
  labels(): Array<{ label: string; kind: string; count: number }> {
    return this.db.prepare(
      `SELECT label, kind, COUNT(*) as count FROM ${this.obs} GROUP BY label ORDER BY kind, label`,
    ).all() as Array<{ label: string; kind: string; count: number }>;
  }

  /** Most recent value per label (a "latest snapshot" — latest labs/vitals). */
  latestPerLabel(kind?: string): Observation[] {
    const sql = `SELECT o.* FROM ${this.obs} o
       JOIN (SELECT label, MAX(date || '/' || printf('%08d', id)) AS mk FROM ${this.obs}${kind ? ' WHERE kind = ?' : ''} GROUP BY label) m
         ON o.label = m.label AND (o.date || '/' || printf('%08d', o.id)) = m.mk
       ORDER BY o.kind, o.label`;
    return (kind ? this.db.prepare(sql).all(kind) : this.db.prepare(sql).all()) as ObsRow[];
  }

  deleteObservation(id: number): boolean {
    return this.db.prepare(`DELETE FROM ${this.obs} WHERE id = ?`).run(id).changes > 0;
  }

  // ---- medications ------------------------------------------------------
  addMedication(m: MedicationInput): number {
    return Number(this.db.prepare(
      `INSERT INTO ${this.meds} (name, dose, frequency, route, start_date, end_date, active, prescriber, rx_number, pharmacy, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(m.name, m.dose ?? '', m.frequency ?? '', m.route ?? '', m.start_date ?? '', m.end_date ?? null, m.end_date ? 0 : 1,
      m.prescriber ?? '', m.rx_number ?? '', m.pharmacy ?? '', m.note ?? '').lastInsertRowid);
  }

  listMedications(activeOnly = false): Medication[] {
    const sql = `SELECT * FROM ${this.meds}${activeOnly ? ' WHERE active = 1' : ''} ORDER BY active DESC, name COLLATE NOCASE ASC`;
    return (this.db.prepare(sql).all() as MedRow[]).map(toMed);
  }

  /** Stop a med as of `endDate` (marks inactive). */
  stopMedication(id: number, endDate: string): boolean {
    return this.db.prepare(
      `UPDATE ${this.meds} SET active = 0, end_date = ?, updated_at = strftime('%s','now') WHERE id = ?`,
    ).run(endDate, id).changes > 0;
  }

  deleteMedication(id: number): boolean {
    return this.db.prepare(`DELETE FROM ${this.meds} WHERE id = ?`).run(id).changes > 0;
  }
}
