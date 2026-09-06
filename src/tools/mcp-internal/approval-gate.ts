import type { ApprovalStore } from '../../approval-store.js';

/** The shape every in-process MCP tool handler returns. The index signature
 *  mirrors the SDK's CallToolResult (which carries optional `_meta`,
 *  `isError`, etc.) so a value of this type is assignable where the SDK
 *  expects its tool-result type. */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  [x: string]: unknown;
}

/**
 * Per-turn context for gating MCP tool calls. Built by the dispatcher from
 * the agent's approval_tools + the live ApprovalStore + the conversation the
 * turn belongs to. Null when the agent gates nothing.
 */
export interface McpGateContext {
  agentId: string;
  conversationId: number | null;
  gatedTools: readonly string[];
  approvals: ApprovalStore;
}

/**
 * Human-in-the-loop gate for an in-process MCP tool, enforced INSIDE the
 * handler — the only place the SDK can't bypass, because the SDK calls our
 * handler and waits for it. If `fullToolName` is in the agent's gated list,
 * block on operator approval before running `run`; on reject, return the
 * operator's reason as the tool result (the model sees it and adapts) and
 * NEVER call `run`. This is the reliable path the dead `canUseTool` couldn't
 * give us.
 *
 * Caveat: while this awaits, the SDK's per-tool timeout is ticking. Fast
 * approvals are fine; long waits need the timeout raised or a defer/resume
 * design (tracked separately).
 */
export async function gateMcpTool(
  gate: McpGateContext | null,
  fullToolName: string,
  args: unknown,
  run: () => Promise<McpToolResult>,
): Promise<McpToolResult> {
  if (gate?.gatedTools.includes(fullToolName)) {
    const decision = await gate.approvals.request({
      agentId: gate.agentId,
      conversationId: gate.conversationId,
      toolName: fullToolName,
      args,
    });
    if (decision.state === 'rejected') {
      const why = decision.reason?.trim()
        ? `Operator rejected this ${fullToolName} call: ${decision.reason.trim()}`
        : `Operator rejected this ${fullToolName} call.`;
      return { content: [{ type: 'text', text: why }] };
    }
  }
  return run();
}
