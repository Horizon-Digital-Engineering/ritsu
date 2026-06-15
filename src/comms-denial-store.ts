import type { Db } from './db.js';
import { approvalBus, type CommsDenialSnapshot } from './approval-bus.js';
import { logger } from './util/log.js';

export type CommsDenialReason = 'not_in_allowlist' | 'escalation' | 'cycle' | 'depth' | 'inflight';

export interface CommsDenialInput {
  caller: string;
  target: string;
  reason: CommsDenialReason;
  /** Human-readable context: escalated caps, call chain, counts. */
  detail?: string | null;
  conversationId?: number | null;
}

/**
 * Persists inter-agent call denials so a blocked `ask_agent` is visible to the
 * operator instead of only living in the journal. `record()` is best-effort and
 * MUST NOT throw — it sits on the security deny path, and failing to log a
 * denial can never be allowed to break (or worse, un-break) the denial itself.
 */
export class CommsDenialStore {
  constructor(private readonly db: Db) {}

  record(input: CommsDenialInput): void {
    try {
      const r = this.db
        .prepare(
          `INSERT INTO comms_denials (caller, target, reason, detail, conversation_id)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.caller, input.target, input.reason, input.detail ?? null, input.conversationId ?? null);
      const snapshot = this.get(Number(r.lastInsertRowid));
      if (snapshot) approvalBus.publish({ kind: 'comms-denied', denial: snapshot });
    } catch (e) {
      logger.warn('comms.denial-record-failed', {
        caller: input.caller, target: input.target, reason: input.reason, err: (e as Error).message,
      });
    }
  }

  get(id: number): CommsDenialSnapshot | null {
    const row = this.db.prepare('SELECT * FROM comms_denials WHERE id = ?').get(id) as CommsDenialSnapshot | undefined;
    return row ?? null;
  }

  listRecent(limit = 100): CommsDenialSnapshot[] {
    return this.db
      .prepare('SELECT * FROM comms_denials ORDER BY id DESC LIMIT ?')
      .all(limit) as CommsDenialSnapshot[];
  }
}
