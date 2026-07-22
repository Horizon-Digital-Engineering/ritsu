/**
 * Insurance coverage: the "what's actually covered / what's my copay /
 * how much deductible is left" layer. A plan holds the cost-sharing shape
 * (deductible, OOP max, premium) and a set of benefits — per service category,
 * per network — that answer "is X covered and what will it cost me." Manual
 * entry today; the ingestion core will auto-fill from an SBC / insurance card.
 */
import type { PluginDb } from '../types.js';

export type Network = 'in' | 'out';
export type CostType = 'copay' | 'coinsurance' | 'covered' | 'not_covered';

export interface InsurancePlan {
  id: number;
  plan_year: number;
  carrier: string;
  plan_name: string;
  plan_type: string;      // PPO / HMO / HDHP / EPO / POS / other
  member_id: string;
  group_number: string;
  effective_from: string;
  effective_to: string;
  premium_monthly: number | null;
  deductible_individual: number | null;
  deductible_family: number | null;
  deductible_met: number;
  oop_max_individual: number | null;
  oop_max_family: number | null;
  oop_met: number;
  active: boolean;
  note: string;
  created_at: number;
  updated_at: number;
}

export interface Benefit {
  id: number;
  plan_id: number;
  category: string;       // 'PCP visit' | 'Specialist' | 'ER' | 'Generic Rx' | 'Imaging' | …
  network: Network;
  cost_type: CostType;
  amount: number;         // $ for copay, % for coinsurance
  after_deductible: boolean;
  note: string;
}

export interface PlanInput {
  plan_year: number;
  carrier: string;
  plan_name: string;
  plan_type?: string;
  member_id?: string;
  group_number?: string;
  effective_from?: string;
  effective_to?: string;
  premium_monthly?: number | null;
  deductible_individual?: number | null;
  deductible_family?: number | null;
  oop_max_individual?: number | null;
  oop_max_family?: number | null;
  note?: string;
}

export interface BenefitInput {
  plan_id: number;
  category: string;
  network?: Network;
  cost_type: CostType;
  amount?: number;
  after_deductible?: boolean;
  note?: string;
}

interface PlanRow extends Omit<InsurancePlan, 'active'> { active: number }
interface BenefitRow extends Omit<Benefit, 'network' | 'cost_type' | 'after_deductible'> { network: string; cost_type: string; after_deductible: number }

const toPlan = (r: PlanRow): InsurancePlan => ({ ...r, active: r.active === 1 });
const toBenefit = (r: BenefitRow): Benefit => ({ ...r, network: r.network as Network, cost_type: r.cost_type as CostType, after_deductible: r.after_deductible === 1 });

export class InsuranceStore {
  constructor(private readonly db: PluginDb) {}

  private get plans(): string { return this.db.table('insurance_plans'); }
  private get benefits(): string { return this.db.table('insurance_benefits'); }

  addPlan(p: PlanInput): number {
    return Number(this.db.prepare(
      `INSERT INTO ${this.plans}
         (plan_year, carrier, plan_name, plan_type, member_id, group_number, effective_from, effective_to,
          premium_monthly, deductible_individual, deductible_family, oop_max_individual, oop_max_family, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.plan_year, p.carrier, p.plan_name, p.plan_type ?? '', p.member_id ?? '', p.group_number ?? '',
      p.effective_from ?? '', p.effective_to ?? '', p.premium_monthly ?? null,
      p.deductible_individual ?? null, p.deductible_family ?? null, p.oop_max_individual ?? null, p.oop_max_family ?? null, p.note ?? '').lastInsertRowid);
  }

  listPlans(): InsurancePlan[] {
    return (this.db.prepare(`SELECT * FROM ${this.plans} ORDER BY active DESC, plan_year DESC`).all() as PlanRow[]).map(toPlan);
  }

  activePlan(): InsurancePlan | null {
    const r = this.db.prepare(`SELECT * FROM ${this.plans} WHERE active = 1 ORDER BY plan_year DESC LIMIT 1`).get() as PlanRow | undefined;
    return r ? toPlan(r) : null;
  }

  getPlan(id: number): InsurancePlan | null {
    const r = this.db.prepare(`SELECT * FROM ${this.plans} WHERE id = ?`).get(id) as PlanRow | undefined;
    return r ? toPlan(r) : null;
  }

  /** Set the running deductible / out-of-pocket totals (manual, or later fed
   *  from EOBs / bills). */
  setProgress(planId: number, deductibleMet: number, oopMet: number): boolean {
    return this.db.prepare(
      `UPDATE ${this.plans} SET deductible_met = ?, oop_met = ?, updated_at = strftime('%s','now') WHERE id = ?`,
    ).run(deductibleMet, oopMet, planId).changes > 0;
  }

  deletePlan(id: number): boolean {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM ${this.benefits} WHERE plan_id = ?`).run(id);
      return this.db.prepare(`DELETE FROM ${this.plans} WHERE id = ?`).run(id).changes > 0;
    });
    return tx();
  }

  addBenefit(b: BenefitInput): number {
    return Number(this.db.prepare(
      `INSERT INTO ${this.benefits} (plan_id, category, network, cost_type, amount, after_deductible, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(b.plan_id, b.category, b.network ?? 'in', b.cost_type, b.amount ?? 0, b.after_deductible ? 1 : 0, b.note ?? '').lastInsertRowid);
  }

  benefitsFor(planId: number): Benefit[] {
    return (this.db.prepare(`SELECT * FROM ${this.benefits} WHERE plan_id = ? ORDER BY category, network`).all(planId) as BenefitRow[]).map(toBenefit);
  }

  deleteBenefit(id: number): boolean {
    return this.db.prepare(`DELETE FROM ${this.benefits} WHERE id = ?`).run(id).changes > 0;
  }

  /** Coverage lookup for a free-text service ("specialist", "ER", "MRI") on the
   *  active plan — fuzzy category match, preferring the requested network. */
  findCoverage(query: string, network: Network = 'in'): Benefit[] {
    const plan = this.activePlan();
    if (!plan) return [];
    const q = query.trim().toLowerCase();
    return this.benefitsFor(plan.id)
      .filter(b => b.category.toLowerCase().includes(q) || q.includes(b.category.toLowerCase()))
      .sort((a, b) => (a.network === network ? -1 : 1) - (b.network === network ? -1 : 1));
  }
}

/** Human-readable cost-share for a benefit. */
export function describeBenefit(b: Benefit): string {
  const net = b.network === 'in' ? 'in-network' : 'out-of-network';
  const after = b.after_deductible ? ' after deductible' : '';
  switch (b.cost_type) {
    case 'copay': return `${net}: $${b.amount} copay${after}`;
    case 'coinsurance': return `${net}: ${b.amount}% coinsurance${after}`;
    case 'covered': return `${net}: covered in full`;
    case 'not_covered': return `${net}: NOT covered`;
  }
}
