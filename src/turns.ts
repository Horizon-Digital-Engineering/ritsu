import { approvalBus, type ApprovalEvent } from './approval-bus.js';
import type { ApprovalStore } from './approval-store.js';

/** Process-wide so Stop reaches a turn whichever surface started it. */
const running = new Map<number, Set<AbortController>>();

export interface TurnHandle {
  readonly signal: AbortSignal;
  end(): void;
}

export function beginTurn(conversationId: number, callerSignal?: AbortSignal): TurnHandle {
  const ctl = new AbortController();
  let turns = running.get(conversationId);
  if (!turns) {
    turns = new Set();
    running.set(conversationId, turns);
  }
  turns.add(ctl);
  const own = turns;
  return {
    signal: callerSignal ? AbortSignal.any([ctl.signal, callerSignal]) : ctl.signal,
    end: () => {
      own.delete(ctl);
      if (own.size === 0 && running.get(conversationId) === own) running.delete(conversationId);
    },
  };
}

/** Returns how many were newly stopped. */
export function stopTurns(conversationId: number): number {
  let n = 0;
  for (const ctl of running.get(conversationId) ?? []) {
    if (ctl.signal.aborted) continue;
    ctl.abort();
    n++;
  }
  return n;
}

export function runningTurns(conversationId: number): number {
  return running.get(conversationId)?.size ?? 0;
}

export const STOPPED_APPROVAL_REASON = 'The turn was stopped before a decision.';

/** Rejects the approvals a stopped turn left pending, so no card waits on a
 *  turn that is gone and the awaiting tool is released. */
export function closeApprovalsOnStop(
  signal: AbortSignal,
  store: ApprovalStore,
  agentId: string,
  conversationId: number | null,
): () => void {
  const raised: number[] = [];
  const reject = (id: number): void => { store.decide(id, 'rejected', STOPPED_APPROVAL_REASON, 'system'); };
  const onEvent = (e: ApprovalEvent): void => {
    if (e.kind !== 'requested' || e.approval.agent_id !== agentId || e.approval.conversation_id !== conversationId) return;
    raised.push(e.approval.id);
    // Raised after the stop: reject once request() has registered its waiter.
    if (signal.aborted) queueMicrotask(() => reject(e.approval.id));
  };
  const onAbort = (): void => { for (const id of raised) reject(id); };
  approvalBus.on('event', onEvent);
  signal.addEventListener('abort', onAbort, { once: true });
  return () => {
    approvalBus.off('event', onEvent);
    signal.removeEventListener('abort', onAbort);
  };
}
