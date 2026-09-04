/**
 * Channel lifecycle: what ends up in the running map, and when.
 *
 * The map is what `runningIds()` reports and what `send()` resolves against, so
 * an entry that does not correspond to a live channel is a message dropped on
 * the floor or a job that reports success having sent nothing. Registering the
 * instance before `start()` resolved meant a channel that failed to start was
 * reported live forever.
 */
import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { ChannelRegistry } from '../channels/registry.js';
import type { ChannelStore } from '../channels/channel-store.js';
import type { ChannelRow, CommChannel, ChannelAgentHost } from '../channels/types.js';

/** A channel that records its lifecycle and can be told to fail either half. */
class FakeChannel implements CommChannel {
  readonly channelId = 1;
  started = 0;
  stopped = 0;
  sent: string[] = [];
  constructor(private readonly opts: { failStart?: boolean; stopDelayMs?: number } = {}) {}
  async start(): Promise<void> {
    if (this.opts.failStart) throw new Error('bot token rejected');
    this.started++;
  }
  async stop(): Promise<void> {
    if (this.opts.stopDelayMs) await new Promise(r => setTimeout(r, this.opts.stopDelayMs));
    this.stopped++;
  }
  async send(text: string): Promise<void> { this.sent.push(text); }
}

/** Registry with the concrete-channel constructor swapped for a fake. */
class TestRegistry extends ChannelRegistry {
  built: FakeChannel[] = [];
  next: () => FakeChannel = () => new FakeChannel();
  protected build(_row: ChannelRow): CommChannel {
    const ch = this.next();
    this.built.push(ch);
    return ch;
  }
}

const row = (over: Partial<ChannelRow> = {}): ChannelRow => ({
  id: 1, name: 'tg', kind: 'telegram', operator_agent_id: 'alice',
  config: {}, enabled: true, created_at: 0, updated_at: 0, ...over,
});

const emptyStore = { listEnabled: () => [] } as unknown as ChannelStore;
const noHost = {} as ChannelAgentHost;

describe('ChannelRegistry lifecycle', () => {
  let reg: TestRegistry;
  beforeEach(() => { reg = new TestRegistry(emptyStore, noHost); });

  it('reports a channel live once it has actually started', async () => {
    await reg.addOrReplace(row());
    assert.deepEqual(reg.runningIds(), [1]);
    assert.equal(reg.built[0].started, 1);
  });

  it('does NOT report a channel that failed to start', async () => {
    reg.next = () => new FakeChannel({ failStart: true });
    await reg.addOrReplace(row());
    assert.deepEqual(reg.runningIds(), [], 'a channel that threw on start is not running');
  });

  it('a failed start does not wedge the id — a later good row still starts', async () => {
    reg.next = () => new FakeChannel({ failStart: true });
    await reg.addOrReplace(row());
    reg.next = () => new FakeChannel();
    await reg.addOrReplace(row());
    assert.deepEqual(reg.runningIds(), [1]);
  });

  it('replacing a running channel stops the old instance first', async () => {
    await reg.addOrReplace(row());
    const first = reg.built[0];
    await reg.addOrReplace(row({ name: 'renamed' }));
    assert.equal(first.stopped, 1, 'the old instance must be stopped, not orphaned');
    assert.equal(reg.built[1].started, 1);
    assert.deepEqual(reg.runningIds(), [1]);
  });

  it('a disabled row stops the channel and leaves nothing running', async () => {
    await reg.addOrReplace(row());
    await reg.addOrReplace(row({ enabled: false }));
    assert.equal(reg.built[0].stopped, 1);
    assert.deepEqual(reg.runningIds(), []);
    assert.equal(reg.built.length, 1, 'a disabled row must not build a new instance');
  });

  it('remove stops it and drops it from the map', async () => {
    await reg.addOrReplace(row());
    await reg.remove(1);
    assert.equal(reg.built[0].stopped, 1);
    assert.deepEqual(reg.runningIds(), []);
  });

  it('send reaches the live channel', async () => {
    await reg.addOrReplace(row());
    await reg.send(1, 'hello');
    assert.deepEqual(reg.built[0].sent, ['hello']);
  });

  it('send THROWS for a channel that is not running', async () => {
    // A disabled or failed channel must surface as a job failure, never as a
    // silently dropped message.
    await assert.rejects(() => reg.send(99, 'hi'), /not running/);
    reg.next = () => new FakeChannel({ failStart: true });
    await reg.addOrReplace(row());
    await assert.rejects(() => reg.send(1, 'hi'), /not running/);
  });

  it('serializes concurrent ops on one id instead of racing them', async () => {
    // Without the lock the second addOrReplace starts a new instance while the
    // first is still inside a slow stop(), and the orphan keeps polling.
    reg.next = () => new FakeChannel({ stopDelayMs: 30 });
    await reg.addOrReplace(row());
    const a = reg.addOrReplace(row());
    const b = reg.addOrReplace(row());
    await Promise.all([a, b]);
    assert.deepEqual(reg.runningIds(), [1]);
    const live = reg.built[reg.built.length - 1];
    for (const ch of reg.built) {
      if (ch !== live) assert.equal(ch.stopped, 1, 'every superseded instance must be stopped');
    }
  });

  it('shutdown stops everything it is running', async () => {
    await reg.addOrReplace(row({ id: 1 }));
    await reg.addOrReplace(row({ id: 2 }));
    await reg.shutdown();
    assert.deepEqual(reg.runningIds(), []);
    for (const ch of reg.built) assert.equal(ch.stopped, 1);
  });

  it('loadAll survives a channel that cannot start', async () => {
    const store = { listEnabled: () => [row({ id: 1 }), row({ id: 2 })] } as unknown as ChannelStore;
    const r = new TestRegistry(store, noHost);
    let n = 0;
    r.next = () => new FakeChannel({ failStart: n++ === 0 });
    await r.loadAll();
    assert.deepEqual(r.runningIds(), [2], 'one bad channel must not take the others down');
  });
});
