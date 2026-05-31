import type { Db } from './db.js';
import { approvalBus, type ApprovalSnapshot } from './approval-bus.js';
import { logger } from './util/log.js';

export type ApprovalState = 'pending' | 'approved' | 'rejected';

/** Resolution returned to the blocked agent turn. On reject, `reason` is fed
 *  back to the model as the tool-denial message so it can adapt. */
export interface ApprovalDecision {
  state: 'approved' | 'rejected';
  reason: string | null;
}

export interface ApprovalRequest {
  agentId: string;
  conversationId: number | null;
  toolName: string;
  /** The tool input the model proposed. Stored verbatim, shown on the card. */
  args: unknown;
}

/**
 * Human-in-the-loop approvals. An agent's dispatcher calls `request()` for a
 * gated tool and awaits the returned promise; the operator resolves it from
 * the admin UI via `decide()`. The turn blocks in between — deliberately, and
 * with no timeout: agents have no deadline, and silently killing their work
 * is the worst failure mode. Staleness is surfaced in the UI instead.
 *
 * The promise resolvers live in an in-memory map keyed by approval id. They
 * do NOT survive a process restart — the agent's turn (an SDK subprocess)
 * dies with the process anyway, so a half-decided approval can't resume.
 * `reconcileOnBoot()` closes any leftover pending rows from a prior process
 * so the operator never sees an un-actionable "pending" that no live turn is
 * waiting on.
 */
export class ApprovalStore {
  private readonly pending = new Map<number, (d: ApprovalDecision) => void>();

  constructor(private readonly db: Db) {}

  /**
   * Create a pending approval and return a promise that resolves when the
   * operator decides. The caller (dispatcher canUseTool) awaits it.
   */
  request(req: ApprovalRequest): Promise<ApprovalDecision> {
    const argsJson = safeStringify(req.args);
    const r = this.db
      .prepare(
        `INSERT INTO tool_approvals (agent_id, conversation_id, tool_name, args_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(req.agentId, req.conversationId, req.toolName, argsJson);
    const id = r.lastInsertRowid;
    const snapshot = this.get(id);
    if (snapshot) approvalBus.publish({ kind: 'requested', approval: snapshot });
    logger.info('approval.requested', {
      id, agent_id: req.agentId, conversation_id: req.conversationId, tool: req.toolName,
    });
    return new Promise<ApprovalDecision>(resolve => {
      this.pending.set(id, resolve);
    });
  }

  /**
   * Resolve a pending approval. Updates the row, publishes 'decided', and
   * unblocks the waiting turn if its resolver is still in this process.
   * Returns the updated snapshot, or null if the id was unknown or already
   * decided (idempotent — a double-click can't double-resolve).
   */
  decide(id: number, state: 'approved' | 'rejected', reason: string | null, decidedBy: string): ApprovalSnapshot | null {
    const res = this.db
      .prepare(
        `UPDATE tool_approvals
            SET state = ?, reason = ?, decided_by = ?, decided_at = strftime('%s','now')
          WHERE id = ? AND state = 'pending'`,
      )
      .run(state, reason, decidedBy, id);
    if (res.changes === 0) return null; // unknown id or already decided
    const snapshot = this.get(id);
    if (!snapshot) return null;
    approvalBus.publish({ kind: 'decided', approval: snapshot });
    logger.info('approval.decided', { id, state, decided_by: decidedBy });
    const resolver = this.pending.get(id);
    if (resolver) {
      this.pending.delete(id);
      resolver({ state, reason });
    }
    return snapshot;
  }

  get(id: number): ApprovalSnapshot | null {
    const row = this.db.prepare('SELECT * FROM tool_approvals WHERE id = ?').get(id) as ApprovalSnapshot | undefined;
    return row ?? null;
  }

  listPending(limit = 200): ApprovalSnapshot[] {
    return this.db
      .prepare(`SELECT * FROM tool_approvals WHERE state = 'pending' ORDER BY requested_at ASC, id ASC LIMIT ?`)
      .all(limit) as ApprovalSnapshot[];
  }

  listDecided(limit = 200): ApprovalSnapshot[] {
    return this.db
      .prepare(`SELECT * FROM tool_approvals WHERE state <> 'pending' ORDER BY decided_at DESC, id DESC LIMIT ?`)
      .all(limit) as ApprovalSnapshot[];
  }

  /** Pending approvals for one conversation, oldest first — the chat panel's
   *  inline cards. */
  listPendingForConversation(conversationId: number): ApprovalSnapshot[] {
    return this.db
      .prepare(`SELECT * FROM tool_approvals WHERE state = 'pending' AND conversation_id = ? ORDER BY requested_at ASC, id ASC`)
      .all(conversationId) as ApprovalSnapshot[];
  }

  pendingCount(): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM tool_approvals WHERE state = 'pending'`).get() as { n: number };
    return r.n;
  }

  /**
   * Close out pending rows left over from a previous process. Their waiting
   * turns died with that process, so they can never resume; mark them
   * rejected with a clear reason so the audit trail is honest and the UI
   * doesn't show un-actionable pendings. Idempotent — a no-op once clean.
   */
  reconcileOnBoot(): void {
    const stale = this.listPending();
    if (stale.length === 0) return;
    const tx = this.db.transaction(() => {
      for (const a of stale) {
        this.db
          .prepare(
            `UPDATE tool_approvals
                SET state = 'rejected',
                    reason = 'ritsu restarted before this was decided; the agent turn ended',
                    decided_by = 'system',
                    decided_at = strftime('%s','now')
              WHERE id = ? AND state = 'pending'`,
          )
          .run(a.id);
      }
    });
    tx();
    logger.warn('approval.reconcile-orphans', { count: stale.length, ids: stale.map(a => a.id) });
  }
}

/** Stringify tool args defensively — a circular or otherwise unserializable
 *  input must not crash the approval path. Falls back to a marker string. */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v ?? {});
  } catch {
    return JSON.stringify({ _unserializable: String(v) });
  }
}
