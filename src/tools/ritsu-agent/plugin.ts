/**
 * Ritsu-agent plugin tools — parity with the claude-direct MCP path
 * (src/plugins/agent-tools.ts `buildPluginToolServer`). A plugin's agent-facing
 * tools are exposed to the native tool-calling loop as RaTools instead of an
 * in-process MCP server. Behaviour matches the MCP path:
 *   - named `mcp__<id>__<name>` so the dispatcher's gatedTools (built with the
 *     same convention in AgentHost) gates declared-mutating tools — and
 *     force-gates ALL of them for crm/social agents.
 *   - `untrustedOutput` tools have their text fenced with the same nonce
 *     delimiters, so plugin-returned data can't smuggle instructions.
 * Gating itself is applied centrally by the dispatcher's `runTool` (via
 * gatedTools), NOT here, so a gated tool isn't double-prompted.
 */
import { z } from 'zod';
import type { RaTool } from '../../model/ritsu-agent/types.js';
import type { PluginToolDef, PluginToolResult } from '../../plugins/types.js';
import { fenceUntrusted } from '../../util/untrusted.js';

/** A plugin's tools bound to its id, as AgentHost resolves them. */
export interface PluginToolSet {
  id: string;
  tools: PluginToolDef[];
}

function resultText(pluginId: string, def: PluginToolDef, result: PluginToolResult): string {
  const text = result.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return def.untrustedOutput ? fenceUntrusted(`${pluginId} plugin data`, text) : text;
}

function jsonSchema(shape: PluginToolDef['input']): Record<string, unknown> {
  const js = z.toJSONSchema(z.object(shape)) as Record<string, unknown>;
  delete js.$schema;  // providers want a bare parameters object, no meta key
  return js;
}

export function buildPluginTools(sets: PluginToolSet[], agentId: string): RaTool[] {
  const out: RaTool[] = [];
  for (const { id, tools } of sets) {
    for (const def of tools) {
      out.push({
        name: `mcp__${id}__${def.name}`,
        description: def.description,
        parameters: jsonSchema(def.input),
        handler: async (args) => resultText(id, def, await Promise.resolve(def.handler(args, { agentId }))),
      });
    }
  }
  return out;
}
