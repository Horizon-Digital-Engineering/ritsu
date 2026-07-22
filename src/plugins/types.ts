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

export interface PluginContext {
  id: string;
  db: PluginDb;
  logger: PluginLogger;
  route(method: RouteMethod, path: string, handler: RouteHandler): void;
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

export interface Plugin {
  manifest: PluginManifest;
  migrate?(db: PluginDb): void;
  defineTools?(ctx: PluginToolContext): void;
  register?(ctx: PluginContext): void;
  assetsDir?: string;
}
