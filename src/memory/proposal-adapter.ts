/**
 * Proposal adapter — surfaces flashback's PROPOSED actions into ritsu's
 * existing human-in-the-loop approval gate, and reports the operator's verdict
 * back to flashback.
 *
 * Flashback can suggest actions (its `/proposals` doors). Rather than a second
 * approval surface, we fold those into the SAME `tool_approvals` table + bus
 * the operator already watches: each proposed action becomes a pending row
 * under the reserved tool name `PROPOSAL_TOOL_NAME`, carrying the flashback
 * proposal id in its args. When the operator approves/denies from the existing
 * Approvals UI, the adapter (subscribed to the approval bus) reports the
 * decision back to flashback, and after ritsu acts, marks it executed.
 *
 * Bounded on purpose: this wires the DATA path (pull proposals -> approval
 * rows -> report decisions). It does NOT itself EXECUTE an approved proposal —
 * turning "approved proposal" into a concrete ritsu action is agent/tool
 * work that varies per proposal kind and is left to the caller (call
 * `reportExecuted` once done). The approval CARD renders via the generic
 * approval UI already; a proposal-specific card is future UI work.
 */
import { approvalBus, type ApprovalEvent } from '../approval-bus.js';
import type { ApprovalStore } from '../approval-store.js';
import { logger } from '../util/log.js';

/** Reserved tool name that marks an approval row as a flashback proposal. The
 *  existing Approvals UI shows it verbatim; the adapter keys off it to route
 *  decisions back to flashback. */
export const PROPOSAL_TOOL_NAME = 'flashback_proposal';

export interface FlashbackProposal {
  id: string;
  /** e.g. "remember" | "supersede" | "notify" — flashback's action kind. */
  kind: string;
  /** Human-readable summary shown on the approval card. */
  summary?: string;
  /** The action payload flashback wants ritsu to carry out on approve. */
  action?: unknown;
  /** Which agent/project the proposal is scoped to, if any. */
  project_id?: string | null;
}

/** Args stored on the approval row so a decision can be routed back. */
interface ProposalArgs {
  proposal_id: string;
  kind: string;
  summary?: string;
  action?: unknown;
}

export interface ProposalClientConfig {
  endpoint: string;
  token: string;
  timeoutMs?: number;
}

/** Thin REST client over flashback's `/proposals` doors. Kept separate from
 *  the record adapter — proposals are a different concern from raw records. */
export class FlashbackProposalClient {
  constructor(private readonly cfg: ProposalClientConfig) {}

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.token}` };
  }
  private signal(): AbortSignal { return AbortSignal.timeout(this.cfg.timeoutMs ?? 5000); }

  /** Proposals flashback is waiting on us to decide. */
  async listProposed(): Promise<FlashbackProposal[]> {
    const res = await fetch(`${this.cfg.endpoint}/proposals?status=proposed`, {
      headers: this.headers(), signal: this.signal(),
    });
    if (!res.ok) throw new Error(`flashback GET /proposals -> ${res.status}`);
    const body = (await res.json()) as { proposals?: FlashbackProposal[] } | FlashbackProposal[];
    return Array.isArray(body) ? body : (body.proposals ?? []);
  }

  async approve(id: string, note?: string): Promise<void> {
    await this.post(`/proposals/${encodeURIComponent(id)}/approve`, note ? { note } : {});
  }
  async deny(id: string, note?: string): Promise<void> {
    await this.post(`/proposals/${encodeURIComponent(id)}/deny`, note ? { note } : {});
  }
  async executed(id: string, result?: unknown): Promise<void> {
    await this.post(`/proposals/${encodeURIComponent(id)}/executed`, result !== undefined ? { result } : {});
  }

  private async post(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${this.cfg.endpoint}${path}`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: this.signal(),
    });
    if (!res.ok) throw new Error(`flashback POST ${path} -> ${res.status}`);
  }
}

/** The subset of ApprovalStore the adapter needs (kept narrow so the adapter
 *  is unit-testable against a stub). */
export interface ProposalApprovalSink {
  request(req: {
    agentId: string; conversationId: number | null; toolName: string; args: unknown;
  }): Promise<{ state: 'approved' | 'rejected'; reason: string | null }>;
  listPending(limit?: number): Array<{ id: number; tool_name: string; args_json: string }>;
}

export interface ProposalAdapterDeps {
  client: FlashbackProposalClient;
  approvals: ApprovalStore;
  /** Which agent proposals are attributed to on the approval card. */
  agentId?: string;
}

/**
 * Bridges flashback proposals to the approval gate. Call `sync()` to pull
 * newly-proposed actions into pending approval rows; `start()` also subscribes
 * to the approval bus so operator decisions flow back to flashback without a
 * second poll.
 */
export class ProposalAdapter {
  private readonly client: FlashbackProposalClient;
  private readonly approvals: ProposalApprovalSink;
  private readonly agentId: string;
  /** flashback proposal_id -> the approval row minted for it (dedup on sync). */
  private readonly minted = new Map<string, number>();
  private busHandler?: (e: ApprovalEvent) => void;

  constructor(deps: ProposalAdapterDeps) {
    this.client = deps.client;
    this.approvals = deps.approvals;
    this.agentId = deps.agentId ?? 'flashback';
  }

  /**
   * Pull flashback's proposed actions and surface each as a pending approval
   * row (skipping ones already minted this process). Returns how many new rows
   * were created. Errors are thrown to the caller — the scheduler that calls
   * this decides whether a flashback outage should be logged-and-ignored.
   */
  async sync(): Promise<number> {
    const proposals = await this.client.listProposed();
    let created = 0;
    for (const p of proposals) {
      if (this.minted.has(p.id)) continue;
      const args: ProposalArgs = { proposal_id: p.id, kind: p.kind, summary: p.summary, action: p.action };
      // request() mints the pending row + publishes 'requested' on the bus.
      // We don't await its decision here — the bus subscription reports back
      // when the operator decides. The floating promise is expected and
      // harmless (it resolves on decide, or never, which leaks nothing beyond
      // one resolver closure until process exit).
      void this.approvals.request({
        agentId: this.agentId, conversationId: null,
        toolName: PROPOSAL_TOOL_NAME, args,
      });
      // Map the row id back to the proposal so bus decisions route correctly.
      // listPending after the mint gives us the row; match on the proposal id.
      const row = this.findRowFor(p.id);
      if (row != null) this.minted.set(p.id, row);
      created++;
    }
    if (created) logger.info('proposal.synced', { created });
    return created;
  }

  private findRowFor(proposalId: string): number | null {
    for (const r of this.approvals.listPending(500)) {
      if (r.tool_name !== PROPOSAL_TOOL_NAME) continue;
      try {
        const a = JSON.parse(r.args_json) as ProposalArgs;
        if (a.proposal_id === proposalId) return r.id;
      } catch { /* skip malformed row */ }
    }
    return null;
  }

  /** Subscribe to the approval bus so an operator decision on a proposal row is
   *  reported back to flashback. Idempotent; `stop()` unsubscribes. */
  start(): void {
    if (this.busHandler) return;
    this.busHandler = (e: ApprovalEvent) => {
      if (e.kind !== 'decided') return;
      const a = e.approval;
      if (a.tool_name !== PROPOSAL_TOOL_NAME) return;
      let proposalId: string | undefined;
      try { proposalId = (JSON.parse(a.args_json) as ProposalArgs).proposal_id; } catch { /* ignore */ }
      if (!proposalId) return;
      // Fire-and-forget the report; a flashback outage must not throw on the
      // bus (it'd take down every other subscriber). Log and move on.
      const note = a.reason ?? undefined;
      const report = a.state === 'approved'
        ? this.client.approve(proposalId, note)
        : this.client.deny(proposalId, note);
      report
        .then(() => logger.info('proposal.reported', { state: a.state, id: proposalId }))
        .catch(err => logger.warn('proposal.report-failed', {
          state: a.state, err: err instanceof Error ? err.message : String(err),
        }));
    };
    approvalBus.on('event', this.busHandler);
  }

  stop(): void {
    if (this.busHandler) { approvalBus.off('event', this.busHandler); this.busHandler = undefined; }
  }

  /** Report that ritsu has carried out an approved proposal. Call after the
   *  action actually ran. Fire-and-forget-safe: throws to the caller so it can
   *  decide, but the common path logs + swallows. */
  async reportExecuted(proposalId: string, result?: unknown): Promise<void> {
    await this.client.executed(proposalId, result);
  }
}
