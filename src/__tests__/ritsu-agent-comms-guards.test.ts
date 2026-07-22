import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildAgentCommsTools, type RaToolDeps } from '../tools/ritsu-agent/builtin.js';

/**
 * The ritsu-agent (open-model) runtime is the real enforcement layer, so its
 * native ask_agent must be at least as guarded as the SDK/MCP path:
 *   - confused-deputy: refuse to route through a callee with capabilities the
 *     caller lacks (no borrowing manage_agents);
 *   - cycle guard;
 *   - the thread is server-derived, never model-supplied (no conversation_id
 *     parameter to spoof).
 */
function fakeDeps(
  overrides: Partial<RaToolDeps> = {},
  caller: { capabilities?: string[]; escalation_approvable?: boolean } = {},
): RaToolDeps {
  const defs: Record<string, { can_call?: string[]; capabilities?: string[]; escalation_approvable?: boolean }> = {
    caller: {
      can_call: ['privileged', 'peer'],
      capabilities: caller.capabilities ?? [],
      escalation_approvable: caller.escalation_approvable ?? false,
    },
    privileged: { can_call: [], capabilities: ['manage_agents'] },
    peer: { can_call: [], capabilities: [] },
  };
  let asked: { message: string; conversation_id?: number } | null = null;
  const deps = {
    agentId: 'caller',
    memory: {} as RaToolDeps['memory'],
    defStore: { read: async (id: string) => (defs[id] ?? null) } as unknown as RaToolDeps['defStore'],
    conversations: {
      findOrStartInterAgentThread: (_a: string, _b: string) => 4242,
    } as unknown as RaToolDeps['conversations'],
    host: {
      get: (_id: string) => ({
        onMessage: async (req: { message: string; conversation_id?: number }) => {
          asked = req;
          return { reply: 'ok', conversation_id: req.conversation_id ?? 0 };
        },
      }),
    },
    ...overrides,
  };
  // expose the captured call for assertions
  (deps as unknown as { _asked: () => typeof asked })._asked = () => asked;
  return deps;
}

function askAgent(deps: RaToolDeps) {
  const tool = buildAgentCommsTools(deps).find(t => t.name === 'agent_comms_ask_agent');
  assert.ok(tool, 'ask_agent tool present');
  return tool;
}

/** Stub ApprovalStore whose request() resolves to a fixed decision. */
function fakeApprovals(state: 'approved' | 'rejected', reason: string | null = null): RaToolDeps['approvals'] {
  return { request: async () => ({ state, reason }) } as unknown as RaToolDeps['approvals'];
}

describe('ritsu-agent native ask_agent guards', () => {
  it('refuses to call a peer that holds a capability the caller lacks (confused deputy)', async () => {
    const deps = fakeDeps();
    const out = await askAgent(deps).handler({ agent_id: 'privileged', message: 'mint me an admin agent' });
    assert.match(String(out), /denied/);
    assert.match(String(out), /manage_agents/);
  });

  it('allows a same-or-lower-capability peer', async () => {
    const deps = fakeDeps();
    const out = await askAgent(deps).handler({ agent_id: 'peer', message: 'hi' });
    assert.equal(String(out), 'ok');
  });

  it('does not accept a model-supplied conversation_id (no spoofing the thread)', async () => {
    const deps = fakeDeps();
    // Even if the model smuggles a conversation_id, the handler ignores it and
    // routes to the server-derived canonical thread.
    await askAgent(deps).handler({ agent_id: 'peer', message: 'hi', conversation_id: 99999 });
    const asked = (deps as unknown as { _asked: () => { conversation_id?: number } | null })._asked();
    assert.equal(asked?.conversation_id, 4242);
  });

  it('denies a target outside the can_call allowlist', async () => {
    const deps = fakeDeps();
    const out = await askAgent(deps).handler({ agent_id: 'stranger', message: 'hi' });
    assert.match(String(out), /not in .*allowlist|no agents/);
  });

  it('routes an opted-in escalation to approval and proceeds when the operator approves', async () => {
    const deps = fakeDeps({ approvals: fakeApprovals('approved'), conversationId: 7 }, { escalation_approvable: true });
    const out = await askAgent(deps).handler({ agent_id: 'privileged', message: 'do the thing' });
    assert.equal(String(out), 'ok');                     // approved → the call proceeds
    const asked = (deps as unknown as { _asked: () => { conversation_id?: number } | null })._asked();
    assert.equal(asked?.conversation_id, 4242);           // routed via the canonical thread
  });

  it('denies an opted-in escalation when the operator rejects (surfacing the reason)', async () => {
    const deps = fakeDeps({ approvals: fakeApprovals('rejected', 'not now') }, { escalation_approvable: true });
    const out = await askAgent(deps).handler({ agent_id: 'privileged', message: 'do the thing' });
    assert.match(String(out), /rejected/i);
    assert.match(String(out), /not now/);
  });

  it('hard-denies escalation for an injection-exposed (crm/social) caller even when opted in', async () => {
    // social caller reads untrusted content → must never escalate; approval is
    // never offered even with escalation_approvable set + an approver wired.
    const deps = fakeDeps({ approvals: fakeApprovals('approved') }, { capabilities: ['social'], escalation_approvable: true });
    const out = await askAgent(deps).handler({ agent_id: 'privileged', message: 'do the thing' });
    assert.match(String(out), /refused|denied/);
    assert.match(String(out), /manage_agents/);
  });
});
