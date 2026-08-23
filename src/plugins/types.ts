import type { Request, Response } from 'express';
import type { z } from 'zod';
import type { Stmt } from '../db.js';

export interface PluginDb {
  table(name: string): string;
  prepare(sql: string): Stmt;
  exec(sql: string): void;
  transaction<T>(fn: () => T): () => T;
}

export interface PluginLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

export type RouteMethod = 'get' | 'post' | 'patch' | 'put' | 'delete';
export type RouteHandler = (req: Request, res: Response) => void | Promise<void>;

/**
 * Encrypted secret storage scoped to ONE plugin (its own namespace in the core
 * SecretStore — a plugin can't touch another's secrets). For connector
 * credentials like a Plaid client secret or per-item access token.
 *
 * `get()` returns plaintext for IN-PROCESS handler use only (calling the
 * upstream API). Handlers MUST NOT return a secret value to a model or log it —
 * same contract as the core SecretStore. `list()` returns names only.
 */
export interface PluginSecrets {
  get(name: string): string | null;
  set(name: string, value: string): void;
  has(name: string): boolean;
  delete(name: string): boolean;
  list(): string[];
}

export interface PluginContext {
  id: string;
  db: PluginDb;
  logger: PluginLogger;
  secrets: PluginSecrets;
  /** The host-resolved ingestion extractor. Its credentials live in the global
   *  'ingest' secret namespace, which a plugin's scoped secrets can't reach, so
   *  the host supplies it ready-built. */
  extractor: import('../ingestion/pipeline.js').Extractor;
  route(method: RouteMethod, path: string, handler: RouteHandler): void;
  /**
   * Declare periodic work this plugin owns.
   *
   * Declarative, not imperative: a plugin re-declares its jobs on every boot,
   * and any it stops declaring are removed. That keeps the schedule a fact
   * about the code rather than accumulated state nobody remembers creating,
   * and means uninstalling the plugin takes its jobs with it.
   *
   * Ids are namespaced by the host, so two plugins can both declare "sync".
   */
  schedule(job: PluginJobSpec): void;
}

/** A job a plugin owns. Deliberately narrower than the full job model. */
export interface PluginJobSpec {
  /** Short name, unique within the plugin. Namespaced by the host. */
  name: string;
  /** Shown in listings. */
  title: string;
  kind: 'every' | 'cron';
  /** "30m" for every; a 5-field expression for cron. */
  spec: string;
  /** IANA zone for cron. Omit for UTC. */
  tz?: string;
  /**
   * Shell command to run. No agent turn: a plugin's periodic work is
   * collection and maintenance, and anything needing judgement should be a job
   * the operator or an agent creates deliberately.
   *
   * Silence means healthy — output is delivered, no output delivers nothing.
   */
  command: string;
  /** Channels to deliver output to. Omit for none. */
  channel_ids?: number[];
}

export type PluginToolResult = { content: Array<{ type: 'text'; text: string }> };

export interface PluginToolDef {
  name: string;
  description: string;
  input: z.ZodRawShape;
  needsApproval?: boolean;
  /** Set on tools that return stored, agent-authored data (list/read tools).
   *  The framework fences the result as UNTRUSTED so a value one agent wrote
   *  can't be laundered as instructions into another agent that reads it. */
  untrustedOutput?: boolean;
  handler: (args: Record<string, unknown>, ctx: { agentId: string }) => Promise<PluginToolResult> | PluginToolResult;
}

export interface PluginToolContext {
  db: PluginDb;
  logger: PluginLogger;
  secrets: PluginSecrets;
  tool(def: PluginToolDef): void;
}

export interface PluginNavTab {
  id: string;
  label: string;
}

export interface PluginNavGroup {
  id: string;
  label: string;
  tabs: PluginNavTab[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  nav?: PluginNavGroup[];
}

/**
 * A recommended agent config a plugin ships — a DEFAULT/preset, not a
 * hardcoded agent. The operator "loads" it into a normal, fully-editable agent
 * (one click) that already knows the plugin's tools + domain rules. This
 * plugin is auto-added to the created agent's plugin allowlist.
 */
export interface PluginAgentSeed {
  /** Agent id to create; defaults to `<pluginId>-assistant`. */
  id?: string;
  name: string;
  description: string;
  system_prompt: string;
  runtime?: 'direct' | 'api';
  /** Provider under the runtime; defaults to 'claude' (direct). */
  provider?: string;
  model?: string;
  /** SDK built-in tools the agent may use (claude-direct). Usually none for a
   *  read/answer domain assistant. */
  tools_allowlist?: string[];
  capabilities?: string[];
  /** Extra plugin ids beyond this one (this plugin is always included). */
  plugins?: string[];
}

export interface Plugin {
  manifest: PluginManifest;
  migrate?(db: PluginDb): void;
  defineTools?(ctx: PluginToolContext): void;
  register?(ctx: PluginContext): void;
  assetsDir?: string;
  /** Optional recommended agent preset (see PluginAgentSeed). */
  agent?: PluginAgentSeed;
}
