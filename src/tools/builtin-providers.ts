import { buildAgentMemoryMcp, MEMORY_TOOL_NAMES, MEMORY_MCP_NAME } from './mcp-internal/memory.js';
import { buildAgentCommsMcp, COMMS_TOOL_NAMES, COMMS_MCP_NAME, type AgentCommsDeps } from './mcp-internal/agent-comms.js';
import { buildAgentAdminMcp, ADMIN_TOOL_NAMES, ADMIN_MCP_NAME, type AgentAdminDeps } from './mcp-internal/agent-admin.js';
import { buildAgentMonitorMcp, MONITOR_TOOL_NAMES, MONITOR_MCP_NAME, type AgentMonitorDeps } from './mcp-internal/agent-monitor.js';
import { buildAgentEmailMcp, EMAIL_TOOL_NAMES, EMAIL_MCP_NAME } from './mcp-internal/email.js';
import { buildAgentSocialMcp, SOCIAL_TOOL_NAMES, SOCIAL_MCP_NAME } from './mcp-internal/social.js';
import { buildAgentSchedulerMcp, SCHEDULER_TOOL_NAMES, SCHEDULER_MCP_NAME } from './mcp-internal/scheduler.js';
import type { McpProvider } from './mcp-gateway.js';
import type { MemoryStore } from '../memory-store.js';
import type { SecretStore } from '../auth/secret-store.js';
import type { ApprovalStore } from '../approval-store.js';
import type { JobStore } from '../scheduler/store.js';

export function memoryProvider(store: MemoryStore): McpProvider {
  return {
    namespace: MEMORY_MCP_NAME,
    build: (ctx) => ({ server: buildAgentMemoryMcp(ctx.agentId, store, ctx.gate), toolNames: [...MEMORY_TOOL_NAMES], gatedTools: [] }),
  };
}

export function commsProvider(deps: AgentCommsDeps): McpProvider {
  return {
    namespace: COMMS_MCP_NAME,
    build: (ctx) => ({ server: buildAgentCommsMcp(ctx.agentId, deps, ctx.gate), toolNames: [...COMMS_TOOL_NAMES], gatedTools: [] }),
  };
}

export function adminProvider(deps: AgentAdminDeps): McpProvider {
  return {
    namespace: ADMIN_MCP_NAME,
    build: (ctx) => ({ server: buildAgentAdminMcp(ctx.agentId, deps), toolNames: [...ADMIN_TOOL_NAMES], gatedTools: [] }),
  };
}

export function monitorProvider(deps: AgentMonitorDeps): McpProvider {
  return {
    namespace: MONITOR_MCP_NAME,
    build: (ctx) => ({ server: buildAgentMonitorMcp(ctx.agentId, deps), toolNames: [...MONITOR_TOOL_NAMES], gatedTools: [] }),
  };
}

export function emailProvider(secrets: SecretStore, approvals: ApprovalStore): McpProvider {
  return {
    namespace: EMAIL_MCP_NAME,
    build: (ctx) => ({
      server: buildAgentEmailMcp({ agentId: ctx.agentId, secrets, approvals, conversationId: ctx.conversationId }),
      toolNames: [...EMAIL_TOOL_NAMES],
      gatedTools: [],
    }),
  };
}

export function socialProvider(secrets: SecretStore, approvals: ApprovalStore): McpProvider {
  return {
    namespace: SOCIAL_MCP_NAME,
    build: (ctx) => ({
      server: buildAgentSocialMcp({ agentId: ctx.agentId, secrets, approvals, conversationId: ctx.conversationId }),
      toolNames: [...SOCIAL_TOOL_NAMES],
      gatedTools: [],
    }),
  };
}

/**
 * Scheduling. Absent during a scheduled run — a job that can schedule jobs has
 * no natural stopping point, and each agent turn it creates costs a model call.
 */
export function schedulerProvider(store: JobStore): McpProvider {
  return {
    namespace: SCHEDULER_MCP_NAME,
    build: (ctx) => ({
      server: buildAgentSchedulerMcp(ctx.agentId, store),
      toolNames: ctx.insideJobRun ? [] : [...SCHEDULER_TOOL_NAMES],
      gatedTools: [],
    }),
  };
}
