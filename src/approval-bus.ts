import { EventEmitter } from 'node:events';

/**
 * Approval-scoped event bus for live UI sync. Separate from conversationBus
 * (chat turns) and eventBus (log entries) so each SSE surface subscribes to
 * exactly its concern. Two event kinds:
 *
 *   - 'requested'  A new pending approval was created. The Approvals page
 *                  prepends it; the chat panel renders an inline card if
 *                  conversation_id matches the open thread; the nav badge
 *                  increments.
 *   - 'decided'    A pending approval resolved (approved | rejected). The
 *                  page moves it to the Decided tab; the inline card flips
 *                  to an audit stamp; the badge decrements.
 *
 * Every event carries the full approval snapshot so subscribers never need
 * a follow-up fetch to render.
 */
export interface ApprovalSnapshot {
  id: number;
  agent_id: string;
  conversation_id: number | null;
  tool_name: string;
  args_json: string;
  state: 'pending' | 'approved' | 'rejected';
  reason: string | null;
  decided_by: string | null;
  requested_at: number;
  decided_at: number | null;
}

/** A blocked inter-agent call (ask_agent refused by a guard). Carried on the
 *  same bus so the Approvals UI's existing SSE stream surfaces denials live,
 *  in a "Blocked" view, without a second stream. */
export interface CommsDenialSnapshot {
  id: number;
  caller: string;
  target: string;
  reason: string;   // not_in_allowlist | escalation | cycle | depth | inflight
  detail: string | null;
  conversation_id: number | null;
  created_at: number;
}

export type ApprovalEvent =
  | { kind: 'requested' | 'decided'; approval: ApprovalSnapshot }
  | { kind: 'comms-denied'; denial: CommsDenialSnapshot };

export class ApprovalBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0); // many SSE clients may attach
  }

  publish(event: ApprovalEvent): void {
    this.emit('event', event);
  }
}

/** Process-wide singleton. */
export const approvalBus = new ApprovalBus();
