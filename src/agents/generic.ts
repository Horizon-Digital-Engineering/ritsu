import { AgentBase } from './base.js';

/**
 * Pure-JSON agent. No custom hooks. Use this for any agent whose behavior
 * is fully captured by its definition (system_prompt, dispatcher, model).
 *
 * When you want custom logic (memory shaping, dispatcher escalation,
 * specialized retrieval), create a new subclass and register it in registry.ts.
 */
export class GenericAgent extends AgentBase {}
