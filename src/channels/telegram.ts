/**
 * Telegram channel: long-polls getUpdates, forwards inbound messages from
 * allowed chat_ids to the operator agent's onMessage, posts the reply back.
 *
 * No external SDK — just `fetch` against api.telegram.org. The bot's auth is
 * the bot_token; the only sender allow-listing is by Telegram chat_id.
 *
 * Shutdown: stop() flips a flag the loop checks each iteration. We use a
 * shorter getUpdates timeout (25s) so shutdown latency stays bounded.
 */
import type { CommChannel, ChannelAgentHost, TelegramConfig } from './types.js';
import { logger } from '../util/log.js';

const TELEGRAM_API = 'https://api.telegram.org';
const LONG_POLL_TIMEOUT_S = 25;
/** Telegram refuses messages over 4096 chars; trim and append an ellipsis. */
const TELEGRAM_TEXT_LIMIT = 4000;

interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; username?: string };
  text?: string;
  date: number;
}
interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface TelegramChannelDeps {
  channelId: number;
  channelName: string;
  operatorAgentId: string;
  config: TelegramConfig;
  host: ChannelAgentHost;
}

/** A chat the bot has heard from recently — used by the admin UI's
 *  "discover chats" helper so the operator can click-to-allow instead of
 *  hunting down their numeric chat_id via @userinfobot. */
export interface RecentChat {
  chat_id: number;
  chat_type: string;
  username: string | null;
  snippet: string;
  seen_at: number;
  allowed: boolean;
}

export class TelegramChannel implements CommChannel {
  readonly channelId: number;
  private readonly name: string;
  private readonly operatorAgentId: string;
  private readonly token: string;
  /** Single bound chat_id. null = unbound, all chats rejected. */
  private readonly boundChatId: number | null;
  private readonly host: ChannelAgentHost;

  /** Track every chat that's hit this bot since startup so the admin UI can
   *  surface them for one-click approval. Bounded to last 50 distinct chats
   *  so a noisy bot doesn't balloon memory. */
  private readonly recentChats = new Map<number, RecentChat>();
  private static readonly RECENT_CHAT_CAP = 50;

  private offset = 0;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  /** Aborts the in-flight long-poll so stop() is near-instant instead of
   *  waiting up to LONG_POLL_TIMEOUT_S for getUpdates to return. */
  private abort: AbortController | null = null;

  constructor(deps: TelegramChannelDeps) {
    this.channelId = deps.channelId;
    this.name = deps.channelName;
    this.operatorAgentId = deps.operatorAgentId;
    this.token = deps.config.bot_token;
    this.boundChatId = deps.config.chat_id ?? null;
    this.host = deps.host;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // Validate the token + log the bot's identity before entering the loop.
    try {
      const me = await this.api<{ id: number; username: string; first_name: string }>('getMe');
      logger.info('channel.telegram.start', {
        channel_id: this.channelId,
        name: this.name,
        operator: this.operatorAgentId,
        bot_username: me.username,
        bot_id: me.id,
        bound_chat_id: this.boundChatId,
      });
    } catch (e) {
      this.running = false;
      throw new Error(`telegram channel ${this.name}: getMe failed: ${(e as Error).message}`);
    }
    this.loopPromise = this.loop().catch(err => {
      logger.error('channel.telegram.loop-crashed', {
        channel_id: this.channelId, err: (err as Error).message,
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    // Yank the long-poll out from under the loop so it returns immediately,
    // instead of waiting up to LONG_POLL_TIMEOUT_S. AbortError is treated as
    // a normal shutdown signal by the catch in loop().
    this.abort?.abort();
    if (this.loopPromise) {
      await this.loopPromise.catch(() => undefined);
      this.loopPromise = null;
    }
    logger.info('channel.telegram.stop', { channel_id: this.channelId, name: this.name });
  }

  private async loop(): Promise<void> {
    while (this.running) {
      this.abort = new AbortController();
      try {
        const updates = await this.fetchUpdates(this.abort.signal);
        await this.dispatchUpdates(updates);
      } catch (err) {
        const cont = await this.handlePollError(err);
        if (!cont) break;
      } finally {
        this.abort = null;
      }
    }
  }

  /** One getUpdates round-trip. Pulled out of the polling loop body so the
   *  loop's control flow (running flag + abort + error handling) reads in
   *  one screen. */
  private async fetchUpdates(signal: AbortSignal): Promise<TelegramUpdate[]> {
    return this.api<TelegramUpdate[]>('getUpdates', {
      offset: this.offset,
      timeout: LONG_POLL_TIMEOUT_S,
      allowed_updates: ['message'],
    }, signal);
  }

  /** Advance the long-poll offset and route each message through handleMessage.
   *  Bails on shutdown to keep latency on stop() bounded. */
  private async dispatchUpdates(updates: TelegramUpdate[]): Promise<void> {
    for (const u of updates) {
      this.offset = u.update_id + 1;
      if (!this.running) return;
      const msg = u.message ?? u.edited_message;
      if (!msg || !msg.text) continue;
      await this.handleMessage(msg);
    }
  }

  /** Classify a poll-loop error. Resolves to false when the loop should stop
   *  (shutdown was requested), true when it should continue. AbortError is
   *  the expected shutdown signal and is handled by the outer `running`
   *  check; everything else logs and sleeps 2s before letting the loop
   *  re-enter fetchUpdates. */
  private async handlePollError(err: unknown): Promise<boolean> {
    if (!this.running) return false;
    if ((err as Error).name === 'AbortError') return true;
    logger.warn('channel.telegram.poll-error', {
      channel_id: this.channelId, err: (err as Error).message,
    });
    await sleep(2000);
    return true;
  }

  /** Snapshot of every chat that's tried to reach this bot since start.
   *  Newest first, capped. Exposed for the admin UI. */
  getRecentChats(): RecentChat[] {
    return [...this.recentChats.values()].sort((a, b) => b.seen_at - a.seen_at);
  }

  private recordRecent(msg: TelegramMessage, allowed: boolean): void {
    const chatId = msg.chat.id;
    const text = msg.text ?? '';
    this.recentChats.set(chatId, {
      chat_id: chatId,
      chat_type: msg.chat.type,
      username: msg.from?.username ?? null,
      snippet: text.length > 80 ? text.slice(0, 77) + '...' : text,
      seen_at: Math.floor(Date.now() / 1000),
      allowed,
    });
    // Bound the map: evict oldest if we exceed the cap.
    if (this.recentChats.size > TelegramChannel.RECENT_CHAT_CAP) {
      const oldest = [...this.recentChats.entries()].sort((a, b) => a[1].seen_at - b[1].seen_at)[0];
      if (oldest) this.recentChats.delete(oldest[0]);
    }
  }

  private async handleMessage(msg: TelegramMessage): Promise<void> {
    const chatId = msg.chat.id;
    const allowed = this.boundChatId !== null && chatId === this.boundChatId;
    this.recordRecent(msg, allowed);
    if (!allowed) {
      logger.warn('channel.telegram.denied', {
        channel_id: this.channelId, chat_id: chatId, from_user: msg.from?.username ?? null,
        reason: this.boundChatId === null ? 'unbound' : 'wrong_chat',
      });
      // Tell the user the bot is locked so they (or the operator) know what
      // to do next. The chat is recorded in recentChats either way — the
      // operator can then click "Bind" in the admin UI.
      const note = this.boundChatId === null
        ? 'this bot is not yet bound to a chat. ask the ritsu operator to bind it (Channels tab → click Bind on this chat).'
        : 'this bot is bound to a different chat.';
      await this.sendReply(chatId, note, msg.message_id).catch(() => undefined);
      return;
    }
    logger.info('channel.telegram.recv', {
      channel_id: this.channelId, chat_id: chatId, from_user: msg.from?.username ?? null,
      operator: this.operatorAgentId, len: msg.text?.length ?? 0,
    });
    try {
      const r = await this.host.get(this.operatorAgentId).onMessage({
        message: msg.text ?? '',
        caller_label: 'telegram',
      });
      await this.sendReply(chatId, r.reply, msg.message_id);
    } catch (err) {
      const detail = (err as Error).message;
      logger.error('channel.telegram.forward-failed', {
        channel_id: this.channelId, chat_id: chatId, err: detail,
      });
      // Surface the error to the user so they don't sit waiting on silence.
      await this.sendReply(chatId, `(ritsu error: ${detail})`, msg.message_id).catch(() => undefined);
    }
  }

  private async sendReply(chatId: number, text: string, replyToMessageId: number): Promise<void> {
    const truncated = text.length > TELEGRAM_TEXT_LIMIT
      ? text.slice(0, TELEGRAM_TEXT_LIMIT - 3) + '...'
      : text;
    await this.api('sendMessage', {
      chat_id: chatId, text: truncated, reply_to_message_id: replyToMessageId,
    });
  }

  /**
   * Telegram Bot API call. Throws on transport failure or `ok: false` body.
   * Generic <T> is the type of the `result` payload. Pass `signal` for
   * long-polls so stop() can interrupt instead of waiting LONG_POLL_TIMEOUT_S.
   */
  private async api<T = unknown>(method: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const url = `${TELEGRAM_API}/bot${this.token}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : '{}',
      ...(signal ? { signal } : {}),
    });
    const text = await res.text();
    let parsed: { ok: boolean; result?: T; description?: string };
    try { parsed = JSON.parse(text) as typeof parsed; }
    catch { throw new Error(`telegram ${method} returned non-JSON: ${text.slice(0, 200)}`); }
    if (!parsed.ok) throw new Error(`telegram ${method}: ${parsed.description ?? 'unknown'}`);
    return parsed.result as T;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
