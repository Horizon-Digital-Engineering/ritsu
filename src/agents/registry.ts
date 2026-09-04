import { GenericAgent } from './generic.js';
import type { AgentBase, AgentDeps } from './base.js';
import type { AgentDefinition } from '../admin/schema.js';

type AgentCtor = new (def: AgentDefinition, deps: AgentDeps) => AgentBase;

/**
 * String-keyed map of `type` → agent class. JSON definitions reference this
 * via the `type` field.
 *
 * Default and intended path: every agent uses 'generic'. The agent's behavior
 * is fully captured by its definition (system_prompt, runtime, provider, model).
 *
 * Extensibility: if/when you need behavior that the prompt can't express
 * (custom memory shaping, runtime escalation per turn, specialized
 * retrieval, tool wiring), write a subclass of AgentBase and add an entry
 * here. Then JSON definitions can opt-in via `"type": "<your-type>"`.
 *
 * Do NOT register agents for specific business use cases here — those belong
 * in JSON. This file is for behavior *kinds*, not personas.
 */
export const AGENT_TYPES: Record<string, AgentCtor> = {
  'generic': GenericAgent,
};

export function buildAgent(def: AgentDefinition, deps: AgentDeps): AgentBase {
  const ctor = AGENT_TYPES[def.type];
  if (!ctor) {
    throw new Error(`Unknown agent type '${def.type}' for id '${def.id}'. Available: ${Object.keys(AGENT_TYPES).join(', ')}`);
  }
  return new ctor(def, deps);
}
