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
        const result = await (def.needsApproval ? gateMcpTool(gate, fullName, args, run) : run());
        return def.untrustedOutput ? fenceResult(pluginId, result) : result;
      });
    }),
  });
}
