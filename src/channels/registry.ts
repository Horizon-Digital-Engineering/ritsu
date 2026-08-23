/**
 * Channel registry: owns the live map of running channel instances. Reads
 * from the channel store at boot and starts an instance for each enabled
 * row. Admin endpoints call addOrReplace / remove directly after mutating
 * the DB — same pattern as AgentHost.
 */
import type { ChannelStore } from './channel-store.js';
import type { CommChannel, ChannelAgentHost, ChannelRow } from './types.js';
import { TelegramConfigSchema } from './types.js';
import { TelegramChannel, type RecentChat } from './telegram.js';
import { logger } from '../util/log.js';

export class ChannelRegistry {
  private readonly running = new Map<number, CommChannel>();
  /**
   * Per-channel-id serialization lock. Two concurrent admin ops (bind, save,
   * toggle-enable) hitting the same channel would otherwise race through
   * addOrReplace: the old instance's stop() is awaiting an in-flight 25s
   * long-poll, the next addOrReplace doesn't see it in `running` (the entry
   * is removed before the await), it starts a new instance, and the orphan
   * keeps polling. Result: duplicate replies on Telegram. We chain ops on
   * a promise per id so they run strictly in sequence.
   */
  private readonly locks = new Map<number, Promise<void>>();

  /** Recent chats seen by a running channel — used by the admin UI to surface
   *  candidate chat_ids for one-click approval. Returns [] if the channel
   *  isn't running or doesn't expose the helper. */
  getRecentChats(channelId: number): RecentChat[] {
    const ch = this.running.get(channelId);
    if (ch instanceof TelegramChannel) return ch.getRecentChats();
    return [];
  }

  /**
   * Host-initiated send to one channel. The scheduler and anything else with
   * something to say outside a conversation goes through here rather than
   * holding a channel instance, so the running map stays owned by the registry
   * and a disabled channel can't be written to through a stale reference.
   *
   * Throws when the channel isn't running — a disabled or failed channel must
   * surface as a job failure, not a silently dropped message.
   */
  async send(channelId: number, text: string): Promise<void> {
    const ch = this.running.get(channelId);
    if (!ch) throw new Error(`channel ${channelId} is not running`);
    await ch.send(text);
  }

  /** Channel ids with a live instance. Lets a caller resolve "all" at send time. */
  runningIds(): number[] {
    return [...this.running.keys()];
  }

  constructor(
    private readonly store: ChannelStore,
    private readonly host: ChannelAgentHost,
  ) {}

  async loadAll(): Promise<void> {
    const rows = this.store.listEnabled();
    for (const row of rows) {
      await this.addOrReplace(row).catch(err => {
        logger.error('channel.start-failed', { id: row.id, name: row.name, err: (err as Error).message });
      });
    }
    logger.info('channel.registry.loaded', { count: this.running.size });
  }

  addOrReplace(row: ChannelRow): Promise<void> {
    return this.serialize(row.id, async () => {
      await this.stopUnlocked(row.id);
      if (!row.enabled) {
        logger.info('channel.disabled', { id: row.id, name: row.name });
        return;
      }
      const instance = this.build(row);
      this.running.set(row.id, instance);
      await instance.start();
    });
  }

  remove(id: number): Promise<void> {
    return this.serialize(id, () => this.stopUnlocked(id));
  }

  /** Run `fn` under the per-id lock — strict serialization with prior ops on
   *  the same channel id. Errors are logged but don't break the chain so
   *  subsequent ops still run. */
  private serialize(id: number, fn: () => Promise<void>): Promise<void> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.then(fn).catch(err => {
      logger.error('channel.op-failed', { id, err: (err as Error).message });
    });
    this.locks.set(id, next);
    return next;
  }

  async shutdown(): Promise<void> {
    const ids = [...this.running.keys()];
    await Promise.all(ids.map(id => this.serialize(id, () => this.stopUnlocked(id))));
    logger.info('channel.registry.shutdown', { stopped: ids.length });
  }

  /** Lock-free stop, only safe to call from inside serialize(). */
  private async stopUnlocked(id: number): Promise<void> {
    const existing = this.running.get(id);
    if (!existing) return;
    this.running.delete(id);
    await existing.stop().catch(err => {
      logger.warn('channel.stop-error', { id, err: (err as Error).message });
    });
  }

  private build(row: ChannelRow): CommChannel {
    if (row.kind === 'telegram') {
      const config = TelegramConfigSchema.parse(row.config);
      return new TelegramChannel({
        channelId: row.id,
        channelName: row.name,
        operatorAgentId: row.operator_agent_id,
        config,
        host: this.host,
      });
    }
    // Exhaustiveness check: row.kind is a string-literal union; if we add
    // a kind here without handling it the type system flags this assignment.
    const _exhaustive: never = row.kind;
    throw new Error(`unknown channel kind: ${JSON.stringify(_exhaustive)}`);
  }
}
