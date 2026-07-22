import type { McpProvider } from '../tools/mcp-gateway.js';
import type { PluginToolDef } from './types.js';
import { buildPluginToolServer, pluginToolFullNames } from './agent-tools.js';

export function pluginMcpProvider(id: string, tools: PluginToolDef[]): McpProvider {
  return {
    namespace: id,
    build: (ctx) => ({
      server: buildPluginToolServer(id, tools, ctx.agentId, ctx.gate),
      toolNames: pluginToolFullNames(id, tools),
      gatedTools: tools.filter(t => t.needsApproval).map(t => `mcp__${id}__${t.name}`),
    }),
  };
}

export function pluginGatedToolNames(id: string, tools: PluginToolDef[]): string[] {
  return tools.filter(t => t.needsApproval).map(t => `mcp__${id}__${t.name}`);
}
