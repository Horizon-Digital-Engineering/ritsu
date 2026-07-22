import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { AgentDefinitionSchema, AgentDefinitionPatchSchema, DispatcherKindSchema, MemoryBackendSchema } from './admin/schema.js';
import type { AgentHost } from './agent-host.js';
import type { MemoryStore } from './memory-store.js';
import type { AgentDefinitionStore } from './agent-definition-store.js';
import type { TokenStore } from './auth/token-store.js';
import type { OAuthStore } from './auth/oauth-store.js';
import { mountOAuthRoutes, RESOURCE_PATH } from './auth/oauth-routes.js';
import { metrics } from './metrics.js';
import { logger } from './util/log.js';
import { stripTrailingSlashes } from './util/path-utils.js';

/**
 * MCP HTTP surface, built on @modelcontextprotocol/sdk.
 *
 * Stateless mode: each request builds its own McpServer + transport and tears
 * them down on close (per the SDK's `simpleStatelessStreamableHttp` example).
 * Tool handlers close over the shared deps (host, memory, defStore, tokens)
 * so there's only ever one of each of those.
 *
 * Six tools registered (no destructive ops):
 *   list_agents, ask_agent, read_agent_memory,
 *   create_agent, update_agent, reload_agent.
 *
 * Auth is optional via `requireAuth`. When required, every /mcp request must
 * carry `Authorization: Bearer rt_...`. The TokenStore acts as an
 * OAuthTokenVerifier; AuthInfo plumbs into tool callbacks via `extra.authInfo`
 * and every call writes an audit row to mcp_token_usage.
 *
 * Standard server endpoints (always open, no auth):
 *   GET /healthz   — alive
 *   GET /readyz    — ready (db open, agents loaded)
 *   GET /version   — name, version, features
 */
/**
 * Auth mode:
 *   - 'auto'  (default): require auth iff at least one active token exists.
 *             First-run / dev: open. Mint a token in the admin UI → auto-locks.
 *   - 'on':   always require.
 *   - 'off':  never require (use only when you genuinely want MCP open, e.g.
 *             a fully trusted private network).
 */
export type AuthMode = 'auto' | 'on' | 'off';

export function parseAuthMode(raw: string | undefined): AuthMode {
  if (raw === 'true' || raw === 'on' || raw === 'required') return 'on';
  if (raw === 'false' || raw === 'off' || raw === 'open') return 'off';
  return 'auto';
}

export interface CreateMcpServerDeps {
  host: AgentHost;
  memory: MemoryStore;
  defStore: AgentDefinitionStore;
  tokens: TokenStore;
  oauth: OAuthStore;
  authMode: AuthMode;
  bindHost: string;
  /**
   * Extra hostnames allowed in the Host header on /mcp requests. The SDK's
   * createMcpExpressApp enables DNS rebinding protection when bound to
   * loopback and rejects anything other than 127.0.0.1/localhost/::1.
   * Reverse proxies (Tailscale Serve, nginx, Cloudflare Tunnel) forward
   * their public hostname in Host — add those here.
   */
  allowedHosts?: string[];
  /**
   * Canonical public origin of this server, e.g. `https://your-host.your-tailnet.ts.net:9443`.
   * Required when OAuth is enabled — used as the issuer URL in metadata
   * documents and as the audience (`resource`) value tokens are bound to.
   * Without it, OAuth flows are disabled but the legacy rt_* tokens still work.
   */
  publicUrl?: string;
  version: string;
}

export const TOOL_NAMES = ['list_agents', 'ask_agent', 'read_agent_memory', 'create_agent', 'update_agent', 'reload_agent'] as const;

/**
 * Human-readable summaries for the admin info page. Kept here so the same
 * descriptions used at registerTool() time are what the UI shows — change
 * one, both update. Full input schemas live inline at registration; the
 * admin UI shows summaries only and points operators at curl/MCP clients
 * for the live schema.
 */
export const TOOL_INFO: ReadonlyArray<{ name: string; summary: string; args: string }> = [
  { name: 'list_agents',       summary: 'List all enabled agents and their basic metadata.',                          args: '(no args)' },
  { name: 'ask_agent',         summary: 'Send a message to an agent. Returns the reply. Pass conversation_id to continue a thread.', args: 'agent_id, message, conversation_id?' },
  { name: 'read_agent_memory', summary: 'Read the most recent active memories for an agent.',                          args: 'agent_id, limit?' },
  { name: 'create_agent',      summary: 'Create a new agent. Saved + wired live, immediately callable via ask_agent.', args: 'id, type, name, description, system_prompt, dispatcher, model, …' },
  { name: 'update_agent',      summary: 'Update one or more fields on an existing agent.',                             args: 'agent_id, patch' },
  { name: 'reload_agent',      summary: 'Rebuild an agent\'s live instance from its DB row. Use after out-of-band changes.', args: 'agent_id' },
];

export function createMcpServer(deps: CreateMcpServerDeps): Express {
  // If allowedHosts is supplied we pass it directly to the SDK (it overrides
  // the loopback auto-protection). Always include loopback in the allowlist
  // so local curl tests keep working alongside reverse-proxied traffic.
  const allowedHosts = deps.allowedHosts && deps.allowedHosts.length > 0
    ? [...new Set([...deps.allowedHosts, '127.0.0.1', 'localhost', '[::1]'])]
    : undefined;
  const app = createMcpExpressApp({
    host: deps.bindHost,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  app.set('trust proxy', 'loopback');

  // Per-IP rate limit on the protocol surface, BEFORE auth — each ask_agent is a
  // real model invocation (cost), and neither a valid-token spray nor an
  // unauthenticated credential-stuffing loop should be unthrottled. Mirrors the
  // admin limiter. OAuth/DCR endpoints have their own limiter; health lives on
  // the admin port.
  const MCP_RATE_WINDOW_MS = 60_000;
  const MCP_RATE_MAX = 120;
  const mcpBuckets = new Map<string, { count: number; resetAt: number }>();
  app.use('/mcp', (req, res, next) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const bucket = mcpBuckets.get(ip);
    if (!bucket || bucket.resetAt < now) {
      mcpBuckets.set(ip, { count: 1, resetAt: now + MCP_RATE_WINDOW_MS });
      next();
      return;
    }
    bucket.count++;
    if (bucket.count > MCP_RATE_MAX) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      res.status(429).json({ jsonrpc: '2.0', error: { code: -32000, message: 'rate limit exceeded' }, id: null });
      return;
    }
    next();
  });

  // MCP port serves the protocol surface (/mcp) plus the OAuth 2.1 endpoints
  // required by MCP-spec clients (claude.ai web "Add custom connector",
  // Claude Desktop Connectors). Ops endpoints (/healthz etc.) live on the
  // admin port — see src/admin/server.ts.

  if (deps.publicUrl) {
    mountOAuthRoutes(app, { oauth: deps.oauth, tokens: deps.tokens, publicUrl: deps.publicUrl });
    logger.info('oauth.mounted', { issuer: deps.publicUrl, resource: `${deps.publicUrl}${RESOURCE_PATH}` });
  } else {
    logger.warn('oauth.disabled', {
      reason: 'RITSU_PUBLIC_URL not set; OAuth-spec clients (claude.ai web) will not work — header-based clients still do',
    });
  }

  const authState = (): 'required' | 'open' => {
    if (deps.authMode === 'on') return 'required';
    if (deps.authMode === 'off') return 'open';
    return deps.tokens.hasAnyActive('mcp') ? 'required' : 'open';
  };

  // Custom bearer middleware. Accepts EITHER:
  //   - rt_*  legacy bearer (header-only clients: Claude Code CLI, curl)
  //   - OAuth access token (claude.ai web + Claude Desktop Connectors)
  // On 401 we set WWW-Authenticate per RFC 9728 §5.1 pointing at the
  // resource metadata so MCP-spec clients can discover the auth server.
  //
  // Bearer middleware is wired unconditionally; whether it's enforced is
  // decided per-request via authState() so 'auto' mode flips with the first
  // minted token without restart.
  const NEVER_EXPIRES = Math.floor(new Date('2999-12-31T00:00:00Z').getTime() / 1000);
  const canonicalResource = deps.publicUrl ? `${deps.publicUrl}${RESOURCE_PATH}` : null;

  const unauthorized = (res: Response, errorCode: string, description: string): void => {
    if (deps.publicUrl) {
      // RFC 9728 §5.1: point clients at the resource metadata document
      // so they can discover the authorization server.
      res.setHeader(
        'WWW-Authenticate',
        `Bearer realm="ritsu", error="${errorCode}", error_description="${description}", resource_metadata="${deps.publicUrl}/.well-known/oauth-protected-resource"`,
      );
    } else {
      res.setHeader('WWW-Authenticate', `Bearer realm="ritsu", error="${errorCode}", error_description="${description}"`);
    }
    res.status(401).json({ error: errorCode, error_description: description });
  };

  const bearer = (req: Request, res: Response, next: () => void): void => {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      unauthorized(res, 'invalid_token', 'bearer token required');
      return;
    }
    const token = header.slice('Bearer '.length).trim();

    // OAuth path — opaque random tokens minted by /oauth/token.
    const oauthInfo = deps.oauth.verifyAccessToken(token);
    if (oauthInfo) {
      // RFC 8707 audience validation: tokens MUST be bound to this resource.
      if (canonicalResource && stripTrailingSlashes(oauthInfo.resource) !== stripTrailingSlashes(canonicalResource)) {
        unauthorized(res, 'invalid_token', 'token audience mismatch');
        return;
      }
      (req as Request & { auth?: AuthInfo }).auth = {
        token,
        clientId: oauthInfo.client_id,
        scopes: oauthInfo.scope.split(/\s+/).filter(Boolean),
        expiresAt: oauthInfo.expires_at,
        extra: { oauthClientId: oauthInfo.client_id },
      };
      next();
      return;
    }

    // Legacy header-based path — rt_* bearer tokens for CLI use.
    const row = deps.tokens.verify(token, 'mcp');
    if (row) {
      (req as Request & { auth?: AuthInfo }).auth = {
        token,
        clientId: row.name,
        scopes: [],
        expiresAt: NEVER_EXPIRES,
        extra: { tokenId: row.id },
      };
      next();
      return;
    }

    unauthorized(res, 'invalid_token', 'invalid or revoked token');
  };

  app.use('/mcp', (req, res, next) => {
    if (authState() === 'open') {
      next();
      return;
    }
    bearer(req, res, next);
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    let server: McpServer | undefined;
    let transport: StreamableHTTPServerTransport | undefined;
    try {
      server = buildMcpServer(deps);
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        // Both close() methods return promises but we're inside a sync
        // res.on('close') callback. Explicit .catch() swallows any
        // failure (a noop sink) so an unhandled-rejection doesn't bubble
        // out of a teardown path the caller has already detached from.
        transport?.close().catch(() => undefined);
        server?.close().catch(() => undefined);
      });
    } catch (err) {
      logger.error('mcp.handler.error', { err: (err as Error).message });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: 'internal server error' },
        });
      }
    }
  });

  // Stateless mode does not use GET/DELETE on /mcp.
  app.get('/mcp', (_req: Request, res: Response) => {
    res.writeHead(405, { Allow: 'POST' }).end(JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Method not allowed' },
    }));
  });
  app.delete('/mcp', (_req: Request, res: Response) => {
    res.writeHead(405, { Allow: 'POST' }).end(JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Method not allowed' },
    }));
  });

  logger.info('mcp.built', { auth_mode: deps.authMode, tool_count: TOOL_NAMES.length });
  return app;
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function buildMcpServer(deps: CreateMcpServerDeps): McpServer {
  const mcp = new McpServer({ name: 'ritsu', version: deps.version });

  function audited<T>(
    tool: string,
    agentIdOf: (args: T) => string | null,
    body: (args: T, auth: AuthInfo | undefined) => Promise<{ text: string; structured?: object }>,
  ): (args: T, extra: { authInfo?: AuthInfo }) => Promise<ToolResult> {
    return async (args, extra) => {
      let status = 200;
      let result: { text: string; structured?: object };
      try {
        result = await body(args, extra.authInfo);
      } catch (err) {
        status = 500;
        const msg = (err as Error).message;
        logger.error('mcp.tool.error', { tool, agent_id: agentIdOf(args), err: msg });
        recordAudit(deps.tokens, extra.authInfo, tool, agentIdOf(args), status);
        metrics.inc(`ritsu_mcp_tool_calls_total{tool="${tool}",status="error"}`);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
      recordAudit(deps.tokens, extra.authInfo, tool, agentIdOf(args), status);
      metrics.inc(`ritsu_mcp_tool_calls_total{tool="${tool}",status="ok"}`);
      return {
        content: [{ type: 'text', text: result.text }],
        structuredContent: result.structured as Record<string, unknown> | undefined,
      };
    };
  }

  mcp.registerTool(
    'list_agents',
    { description: 'List all enabled agents and their basic metadata.', inputSchema: {} },
    audited<Record<string, never>>('list_agents', () => null, async () => {
      const agents = deps.host.list();
      return { structured: { agents }, text: JSON.stringify(agents, null, 2) };
    }),
  );

  mcp.registerTool(
    'ask_agent',
    {
      description: 'Send a message to an agent. Returns the agent\'s reply. ' +
        'Pass conversation_id to continue an existing conversation; omit to start a new one.',
      inputSchema: {
        agent_id: z.string().describe('Stable id of the agent to call.'),
        message: z.string().describe('The user message to send.'),
        conversation_id: z.number().int().positive().optional()
          .describe('Conversation id from a prior ask_agent response. Omit to start fresh.'),
      },
    },
    audited<{ agent_id: string; message: string; conversation_id?: number }>(
      'ask_agent',
      a => a.agent_id,
      async (args, auth) => {
        // For legacy rt_* bearer auth, clientId is the token's display name
        // (set in the auth middleware). For OAuth, it's the OAuth client_id.
        // Either way it's the right human-readable attribution.
        const caller_label = auth?.clientId ?? '(anonymous mcp)';
        const r = await deps.host.get(args.agent_id).onMessage({
          message: args.message,
          conversation_id: args.conversation_id,
          caller_label,
        });
        return { structured: r, text: r.reply };
      },
    ),
  );

  mcp.registerTool(
    'read_agent_memory',
    {
      description: 'Read the most recent active memories for an agent.',
      inputSchema: {
        agent_id: z.string().describe('Stable id of the agent.'),
        limit: z.number().int().positive().max(500).optional()
          .describe('Max number of memories to return (default 50).'),
      },
    },
    audited<{ agent_id: string; limit?: number }>(
      'read_agent_memory',
      a => a.agent_id,
      async (args) => {
        const memories = await deps.memory.list(args.agent_id, args.limit ?? 50);
        return { structured: { memories }, text: JSON.stringify(memories, null, 2) };
      },
    ),
  );

  mcp.registerTool(
    'create_agent',
    {
      description: 'Create a new agent. Returns the saved definition. ' +
        'The agent is wired live and immediately callable via ask_agent.',
      inputSchema: {
        id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/)
          .describe('Stable kebab-case identifier. Cannot be changed later.'),
        type: z.string().default('generic')
          .describe('Agent class key (see AGENT_TYPES; almost always "generic").'),
        name: z.string().describe('Human-readable name.'),
        description: z.string().describe('Short description of what the agent does.'),
        system_prompt: z.string().describe('System prompt that defines the agent\'s persona and rules.'),
        dispatcher: DispatcherKindSchema.describe('Which model dispatcher to use (claude-direct or litellm).'),
        model: z.string().describe('Model name passed to the dispatcher (e.g. "claude-sonnet-4-6" or "ollama/llama3").'),
        memory_backend: MemoryBackendSchema.default('sqlite').describe('Memory backend (sqlite for V1).'),
        tools_allowlist: z.array(z.string()).default([]).describe('Reserved for V2 tool gating; pass [].'),
        can_call: z.array(z.string()).default([]).describe('Agent ids this agent is allowed to ask_agent. Empty = no inter-agent calls.'),
        provider: z.enum(['anthropic', 'openai', 'openai-compat', 'litellm']).nullable().default(null).describe('Phase A: stored but not yet consumed by the runtime; null = use the claude-direct dispatcher.'),
        api_key_ref: z.number().int().positive().nullable().default(null).describe('Phase A: api_keys.id reference for the provider. Null until Phase B wires it.'),
        provider_options: z.record(z.string(), z.unknown()).default({}).describe('Phase A: provider-specific options (temperature, max_tokens, etc).'),
        capabilities: z.array(z.enum(['manage_agents', 'monitor_agents'])).default([])
          .describe('Per-agent capabilities. Empty by default.'),
        approval_tools: z.array(z.string()).default([])
          .describe('Tool names that require operator approval before each use (e.g. ["Bash","Write"]). Empty = no gating.'),
        plugins: z.array(z.string()).default([])
          .describe('Plugin ids this agent may use (its agent-facing tools get wired in). Empty = none.'),
        enabled: z.boolean().default(true).describe('Whether the agent is callable.'),
        escalation_approvable: z.boolean().default(false).describe('Route capability-escalation ask_agent calls to operator approval instead of hard-denying. Default false; ignored for crm/social agents.'),
        allow_monitor_read: z.boolean().default(false).describe("Let monitor_agents-capable agents read THIS agent's conversations and memory. Default false (opaque)."),
      },
    },
    audited<z.infer<typeof AgentDefinitionSchema>>(
      'create_agent',
      a => a.id,
      async (args) => {
        const validated = AgentDefinitionSchema.parse(args);
        // SECURITY: an MCP token is strictly below admin (threat model: "an MCP
        // token cannot reach admin"). Capabilities are privilege grants — minting
        // a manage_agents/monitor_agents agent would be admin-equivalent power —
        // so MCP-created agents get NONE. Grant capabilities via the admin UI.
        validated.capabilities = [];
        const existing = await deps.defStore.read(validated.id);
        if (existing) throw new Error(`agent ${validated.id} already exists; use update_agent`);
        const saved = await deps.defStore.upsert(validated);
        deps.host.addOrReplace(saved);
        return { structured: saved, text: `created ${saved.id}` };
      },
    ),
  );

  mcp.registerTool(
    'update_agent',
    {
      description: 'Update one or more fields of an existing agent. Returns the updated definition. ' +
        'Pass {enabled: false} to disable an agent without deleting it.',
      inputSchema: {
        agent_id: z.string().describe('Stable id of the agent to update.'),
        patch: z.object({
          type: z.string().optional(),
          name: z.string().optional(),
          description: z.string().optional(),
          system_prompt: z.string().optional(),
          dispatcher: DispatcherKindSchema.optional(),
          model: z.string().optional(),
          memory_backend: MemoryBackendSchema.optional(),
          tools_allowlist: z.array(z.string()).optional(),
          can_call: z.array(z.string()).optional(),
          capabilities: z.array(z.enum(['manage_agents', 'monitor_agents'])).optional(),
          enabled: z.boolean().optional(),
        }).describe('Partial definition; only the fields you want to change.'),
      },
    },
    audited<{ agent_id: string; patch: Record<string, unknown> }>(
      'update_agent',
      a => a.agent_id,
      async (args) => {
        const current = await deps.defStore.read(args.agent_id);
        if (!current) throw new Error(`agent ${args.agent_id} not found`);
        // SECURITY: MCP tokens can't manage privileged agents. Refuse to edit an
        // agent that holds any capability (operator-managed), and never let an
        // MCP patch add/change capabilities — so an MCP caller can't commandeer a
        // crm/social/manage agent or self-escalate via update.
        if (current.capabilities.length > 0) {
          throw new Error(`agent ${args.agent_id} holds operator-only capabilities; edit it from the admin UI`);
        }
        const patch = AgentDefinitionPatchSchema.parse(args.patch);
        delete patch.capabilities;
        const merged = AgentDefinitionSchema.parse({ ...current, ...patch, id: current.id, capabilities: current.capabilities });
        const saved = await deps.defStore.upsert(merged);
        deps.host.addOrReplace(saved);
        return { structured: saved, text: `updated ${saved.id}` };
      },
    ),
  );

  mcp.registerTool(
    'reload_agent',
    {
      description: 'Rebuild an agent\'s live instance from its DB row. Useful after out-of-band changes.',
      inputSchema: { agent_id: z.string().describe('Stable id of the agent to reload.') },
    },
    audited<{ agent_id: string }>(
      'reload_agent',
      a => a.agent_id,
      async (args) => {
        const def = await deps.defStore.read(args.agent_id);
        if (!def) throw new Error(`agent ${args.agent_id} not found`);
        deps.host.addOrReplace(def);
        return { structured: { reloaded: def.id }, text: `reloaded ${def.id}` };
      },
    ),
  );

  return mcp;
}

function recordAudit(
  tokens: TokenStore,
  auth: AuthInfo | undefined,
  tool: string,
  agentId: string | null,
  status: number,
): void {
  const tokenId = auth?.extra?.tokenId;
  if (typeof tokenId !== 'number') return;
  try {
    tokens.recordUsage(tokenId, tool, agentId, status);
  } catch (err) {
    logger.warn('mcp.audit.fail', { err: (err as Error).message });
  }
}
