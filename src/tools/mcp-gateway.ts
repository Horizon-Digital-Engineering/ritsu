import type { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { McpGateContext } from './mcp-internal/approval-gate.js';

export type SdkMcpServer = ReturnType<typeof createSdkMcpServer>;

/** Per-turn context handed to every provider when the dispatcher assembles
 *  an agent's tools. gate is null when the agent gates nothing. */
export interface McpBuildContext {
  agentId: string;
  conversationId: number | null;
  gate: McpGateContext | null;
}

export interface McpProviderBuild {
  server: SdkMcpServer;
  toolNames: string[];
  gatedTools: string[];
}

/** A tool group — built-in (memory, comms, …) or plugin. The gateway assembles
 *  all active providers uniformly; adding a group needs no assembler change. */
export interface McpProvider {
  namespace: string;
  build(ctx: McpBuildContext): McpProviderBuild;
}

export interface AssembledMcp {
  mcpServers: Record<string, SdkMcpServer>;
  allowedTools: string[];
  gatedTools: string[];
}

export function assembleMcp(providers: McpProvider[], ctx: McpBuildContext): AssembledMcp {
  const mcpServers: Record<string, SdkMcpServer> = {};
  const allowedTools: string[] = [];
  const gatedTools: string[] = [];
  for (const p of providers) {
    const built = p.build(ctx);
    mcpServers[p.namespace] = built.server;
    allowedTools.push(...built.toolNames);
    gatedTools.push(...built.gatedTools);
  }
  return { mcpServers, allowedTools, gatedTools };
}
