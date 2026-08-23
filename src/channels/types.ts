/**
 * Communication channel = one bot/account on a chat platform (Telegram, etc.)
 * bound to one ritsu agent (the "operator"). Inbound messages get forwarded
 * to that agent; replies get posted back. The operator agent can delegate to
 * other agents via its existing `mcp__agent_comms__ask_agent` toolbelt — its
 * `can_call` allowlist governs who it's allowed to talk to.
 */
import { z } from 'zod';

export const ChannelKindSchema = z.enum(['telegram']);
export type ChannelKind = z.infer<typeof ChannelKindSchema>;

/** Telegram-specific config payload. One bot, one bound chat. */
export const TelegramConfigSchema = z.object({
  /** Bot API token from @BotFather. Stored plaintext; redacted in admin UI. */
  bot_token: z.string().min(10),
  /** The single Telegram chat permitted to talk to this bot. Null = unbound
   *  (bot rejects everyone until the operator clicks "Bind" on a chat in the
   *  recent-chats panel). One bot, one chat, period. */
  chat_id: z.number().int().nullable().default(null),
});
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;

export const ChannelConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('telegram'), config: TelegramConfigSchema }),
]);

export interface ChannelRow {
  id: number;
  name: string;
  kind: ChannelKind;
  operator_agent_id: string;
  /** Parsed JSON payload, shape determined by `kind` (see *ConfigSchema). */
  config: unknown;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

/**
 * One running channel instance. The registry creates one of these per
 * enabled row in the `channels` table and stops them on shutdown / config
 * change. Each implementation owns its own loop (long-poll, websocket, etc.).
 */
export interface CommChannel {
  /** Stable id from the DB row, for logging + registry bookkeeping. */
  readonly channelId: number;
  /** Begin processing inbound messages. Resolves once the loop is running. */
  start(): Promise<void>;
  /** Graceful shutdown — drain in-flight messages, stop polling. */
  stop(): Promise<void>;
  /**
   * Host-initiated send, with no inbound message to reply to. Everything that
   * originates outside a conversation — scheduled jobs, alerts — goes through
   * here; the inbound loop keeps replying on its own path.
   *
   * Throws when the channel has no destination bound, rather than silently
   * discarding: a reminder that vanishes is worse than one that errors.
   */
  send(text: string): Promise<void>;
}

/** Minimal AgentHost surface that channels need to forward inbound messages. */
export interface ChannelAgentHost {
  get(id: string): { onMessage(req: { message: string; conversation_id?: number; caller_label?: string | null }): Promise<{ reply: string; conversation_id: number }> };
}
