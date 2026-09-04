import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { gateMcpTool, type McpGateContext } from '../tools/mcp-internal/approval-gate.js';
import { fenceUntrusted } from '../util/untrusted.js';
import type { PluginToolDef, PluginToolResult } from './types.js';

function fenceResult(pluginId: string, result: PluginToolResult): PluginToolResult {
  return {
    ...result,
    content: result.content.map(b =>
      b.type === 'text' ? { ...b, text: fenceUntrusted(`${pluginId} plugin data`, b.text) } : b,
    ),
  };
}

export function pluginToolFullNames(pluginId: string, tools: PluginToolDef[]): string[] {
  return tools.map(t => `mcp__${pluginId}__${t.name}`);
}

export function buildPluginToolServer(
  pluginId: string,
  tools: PluginToolDef[],
  agentId: string,
  gate: McpGateContext | null = null,
) {
  return createSdkMcpServer({
    name: pluginId,
    version: '0.1.0',
    tools: tools.map(def => {
      const fullName = `mcp__${pluginId}__${def.name}`;
      return tool(def.name, def.description, def.input, async (args: Record<string, unknown>) => {
        const run = () => Promise.resolve(def.handler(args, { agentId }));
        // Unconditional: gateMcpTool already no-ops unless the name is in the
        // agent's gated list, and `needsApproval` is only the PLUGIN AUTHOR's
        // opinion. AgentHost gates a wider set — every tool of every plugin for
        // an injection-exposed agent, plus anything the operator named — and
        // checking the author's flag here quietly dropped all of those.
        const result = await gateMcpTool(gate, fullName, args, run);
        return def.untrustedOutput ? fenceResult(pluginId, result) : result;
      });
    }),
  });
}
