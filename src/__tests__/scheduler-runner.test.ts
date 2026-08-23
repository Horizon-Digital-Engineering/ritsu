import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { SqliteJobStore, type JobUpsert } from '../scheduler/store.js';
import { SchedulerRunner, type JobDelivery, type JobAgentHost } from '../scheduler/runner.js';
import { MAX_CONSECUTIVE_FAILURES } from '../scheduler/types.js';

class FakeDelivery implements JobDelivery {
  readonly sent: Array<{ channelId: number; text: string }> = [];
  running = [1];
  failing = new Set<number>();
  async send(channelId: number, text: string): Promise<void> {
    if (this.failing.has(channelId)) throw new Error(`channel ${channelId} is not running`);
    this.sent.push({ channelId, text });
  }
  runningIds(): number[] { return this.running; }
}

class FakeAgents implements JobAgentHost {
  readonly calls: Array<{ id: string; message: string; conversation_id?: number }> = [];
  nextConversationId = 42;
  reply = 'logged';
  get(id: string) {
    return {
      onMessage: async (req: { message: string; conversation_id?: number }) => {
        this.calls.push({ id, message: req.message, conversation_id: req.conversation_id });
        return { reply: this.reply, conversation_id: req.conversation_id ?? this.nextConversationId };
      },
    };
  }
}

const NOW = Date.parse('2026-08-05T14:30:00Z');

function job(over: Partial<JobUpsert> = {}): JobUpsert {
  return {
    id: 'meds',
    name: 'Meds check-in',
    schedule: { kind: 'every', spec: '1d' },
    payload: { kind: 'notify', text: 'Have you taken it?' },
    delivery: { channel_ids: [1] },
    ...over,
  };
}

describe('scheduler/runner', () => {
  let store: SqliteJobStore;
  let delivery: FakeDelivery;
  let agents: FakeAgents;
  let runner: SchedulerRunner;

  beforeEach(() => {
    store = new SqliteJobStore(openDatabase(':memory:'));
    delivery = new FakeDelivery();
    agents = new FakeAgents();
    runner = new SchedulerRunner({ store, delivery, agents, now: () => NOW });
  });

  const arm = (id = 'meds'): void => store.setNextRun(id, NOW - 1000);

  it('fires a due job and delivers it', async () => {
    store.upsert(job());
    arm();
    await runner.tick();
    assert.deepEqual(delivery.sent, [{ channelId: 1, text: 'Have you taken it?' }]);
    assert.equal(store.state('meds')?.last_status, 'ok');
  });

  it('does not fire a job that is not yet due', async () => {
    store.upsert(job());
    store.setNextRun('meds', NOW + 60_000);
    await runner.tick();
    assert.equal(delivery.sent.length, 0);
  });

  describe('a job is claimed exactly once', () => {
    it('a second run against the same due time is refused', async () => {
      store.upsert(job());
      arm();
      // Two ticks racing on the same due-list: the claim decides, not a
      // best-effort in-process set that a stale batch could sidestep.
      await Promise.all([runner.tick(), runner.tick()]);
      assert.equal(delivery.sent.length, 1, 'a reminder must not be delivered twice');
    });

    it('an overlapping tick is skipped outright', async () => {
      store.upsert(job());
      arm();
      const first = runner.tick();
      await runner.tick();
      await first;
      assert.equal(delivery.sent.length, 1);
    });
  });

  describe('one-shots', () => {
    it('an "at" job with a relative spec fires once and is marked exhausted', async () => {
      store.upsert(job({ id: 'once', schedule: { kind: 'at', spec: '2h' } }));
      store.setNextRun('once', NOW - 1000);

      await runner.tick();
      await runner.tick();

      assert.equal(delivery.sent.length, 1, '"remind me in 2 hours" must not repeat');
      assert.equal(store.state('once')?.disabled_reason, 'exhausted');
    });
  });

  describe('auto-disable', () => {
    const broken = (): JobUpsert => job({
      id: 'broken',
      payload: { kind: 'script', command: 'exit 3' },
    });

    it('records why it stopped, not just that it stopped', async () => {
      store.upsert(broken());
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) { arm('broken'); await runner.tick(); }

      const state = store.state('broken');
      assert.equal(state?.consecutive_failures, MAX_CONSECUTIVE_FAILURES);
      assert.equal(state?.disabled_reason, 'consecutive-failures',
        'a null next_run_at alone means five different things');
    });

    it('hides the job from the default listing', async () => {
      store.upsert(broken());
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) { arm('broken'); await runner.tick(); }
      assert.equal(store.list().find(j => j.id === 'broken'), undefined);
      assert.ok(store.list(true).find(j => j.id === 'broken'), 'still visible when asked for all');
    });

    it('survives a restart', async () => {
      store.upsert(broken());
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) { arm('broken'); await runner.tick(); }

      new SchedulerRunner({ store, delivery, agents, now: () => NOW }).start();

      assert.equal(store.state('broken')?.next_run_at, null,
        'a restart must not resurrect a job the scheduler gave up on');
    });

    it('is cleared by an explicit enable plus a re-arm', async () => {
      store.upsert(broken());
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) { arm('broken'); await runner.tick(); }

      store.setEnabled('broken', true);
      store.setNextRun('broken', NOW + 60_000);

      const state = store.state('broken');
      assert.equal(state?.disabled_reason, null);
      assert.equal(state?.consecutive_failures, 0);
      assert.ok(store.list().find(j => j.id === 'broken'));
    });
  });

  describe('triggers', () => {
    it('a decline is a skip and does not count against the job', async () => {
      store.upsert(job({ trigger: { command: 'echo \'{"fire":false}\'' } }));
      arm();
      await runner.tick();

      assert.equal(delivery.sent.length, 0);
      assert.equal(store.state('meds')?.last_status, 'skipped');
      assert.equal(store.state('meds')?.consecutive_failures, 0);
    });

    it('a broken gate is an error, not a skip', async () => {
      store.upsert(job({ trigger: { command: 'this-binary-does-not-exist' } }));
      arm();
      await runner.tick();

      const state = store.state('meds');
      assert.equal(state?.last_status, 'gate_error',
        'a typo\'d trigger must be distinguishable from a gate declining');
      assert.equal(state?.consecutive_failures, 1, 'and must count toward auto-disable');
    });

    it('records the gate failure so it is diagnosable', async () => {
      store.upsert(job({ trigger: { command: 'exit 7' } }));
      arm();
      await runner.tick();

      const run = store.runs('meds', 1)[0];
      assert.equal(run.status, 'gate_error');
      assert.ok(run.error, 'the reason must be in the run history, not only in a log line');
    });

    it('alerts on a broken gate when a failure channel is set', async () => {
      store.upsert(job({
        trigger: { command: 'exit 7' },
        delivery: { channel_ids: [1], failure_channel_id: 9 },
      }));
      arm();
      await runner.tick();
      assert.equal(delivery.sent.filter(s => s.channelId === 9).length, 1);
    });

    it('persists gate state only after a completed run', async () => {
      store.upsert(job({ trigger: { command: 'echo \'{"fire":true,"state":{"seen":7}}\'' } }));
      arm();
      await runner.tick();
      assert.deepEqual(store.triggerState('meds'), { seen: 7 });
    });
  });

  describe('the silence convention', () => {
    it('delivers nothing when a script produces no output', async () => {
      store.upsert(job({ id: 'watchdog', payload: { kind: 'script', command: 'true' } }));
      arm('watchdog');
      await runner.tick();
      assert.equal(delivery.sent.length, 0);
      assert.equal(store.state('watchdog')?.last_status, 'ok');
    });

    it('delivers when it does produce output', async () => {
      store.upsert(job({ id: 'watchdog', payload: { kind: 'script', command: 'echo disk full' } }));
      arm('watchdog');
      await runner.tick();
      assert.match(delivery.sent[0].text, /disk full/);
    });
  });

  describe('delivery', () => {
    it('fails the job when every channel fails', async () => {
      delivery.failing.add(1);
      store.upsert(job());
      arm();
      await runner.tick();

      assert.equal(store.state('meds')?.last_status, 'error',
        '"the job ran" and "you received it" must not be different facts');
    });

    it('succeeds when at least one channel accepts', async () => {
      delivery.failing.add(1);
      store.upsert(job({ delivery: { channel_ids: [1, 2] } }));
      arm();
      await runner.tick();

      assert.equal(store.state('meds')?.last_status, 'ok');
      assert.equal(delivery.sent.length, 1);
    });
  });

  describe('agent turns', () => {
    const checkin = (): JobUpsert => job({
      id: 'checkin',
      payload: { kind: 'agent_turn', agent_id: 'health', message: 'Did you take it?' },
    });

    it('pins the conversation on the first run and reuses it', async () => {
      store.upsert(checkin());
      arm('checkin'); await runner.tick();
      arm('checkin'); await runner.tick();

      assert.equal(agents.calls[0].conversation_id, undefined);
      assert.equal(agents.calls[1].conversation_id, 42,
        'the agent must see one thread, or it cannot say "you missed yesterday"');
    });

    it('does not resurrect a job deleted mid-run', async () => {
      store.upsert(checkin());
      arm('checkin');
      // Pinning used to rewrite the whole row from a snapshot taken at tick
      // start, which re-inserted a job an operator had deleted.
      const tick = runner.tick();
      store.delete('checkin');
      await tick;

      assert.equal(store.read('checkin'), null);
    });
  });

  describe('context_from', () => {
    it('prepends an upstream job\'s output, fenced as untrusted', async () => {
      store.upsert(job({ id: 'collect', payload: { kind: 'script', command: 'echo "weight 181"' } }));
      arm('collect'); await runner.tick();

      store.upsert(job({
        id: 'summarize',
        payload: { kind: 'agent_turn', agent_id: 'health', message: 'Summarize.' },
        context_from: ['collect'],
      }));
      arm('summarize'); await runner.tick();

      const turn = agents.calls.at(-1)?.message ?? '';
      assert.match(turn, /weight 181/);
      assert.ok(turn.length > 'weight 181\n\nSummarize.'.length + 20,
        'command output reaching an agent prompt must be fenced like every other untrusted ingress');
    });

    it('refuses upstream output that is too old to be current', async () => {
      store.upsert(job({ id: 'collect', payload: { kind: 'script', command: 'echo stale' } }));
      arm('collect'); await runner.tick();
      // Park the collector: the point is a downstream job reading output that
      // stopped being refreshed, not one racing a healthy upstream.
      store.setNextRun('collect', null);

      const threeDaysOn = NOW + 3 * 86_400_000;
      const later = new SchedulerRunner({ store, delivery, agents, now: () => threeDaysOn });
      store.upsert(job({
        id: 'summarize',
        payload: { kind: 'agent_turn', agent_id: 'health', message: 'Summarize.' },
        context_from: ['collect'],
      }));
      store.setNextRun('summarize', threeDaysOn - 1000);
      await later.tick();

      assert.doesNotMatch(agents.calls.at(-1)?.message ?? '', /stale/,
        'a broken collector must not have its old output served as current');
    });
  });

  describe('boot reconciliation', () => {
    it('closes out runs abandoned by a previous process', () => {
      store.upsert(job());
      store.startRun('meds', NOW);
      assert.equal(store.runs('meds', 1)[0].status, 'running');

      const closed = store.reconcileOnBoot();

      assert.equal(closed, 1);
      const run = store.runs('meds', 1)[0];
      assert.equal(run.status, 'error', 'a killed run must not be recorded as a success');
      assert.ok(run.error);
    });
  });

  describe('history growth', () => {
    it('prunes to a bounded number of runs per job', () => {
      store.upsert(job());
      for (let i = 0; i < 250; i++) {
        const id = store.startRun('meds', NOW + i);
        store.finishRun(id, NOW + i, 'ok', 'x', null);
      }
      assert.equal(store.pruneRuns(200), 50);
      assert.equal(store.runs('meds', 1000).length, 200);
    });
  });

  describe('unattended command safety', () => {
    it('kills the whole process tree on timeout, not just the shell', async () => {
      store.upsert(job({
        id: 'hang',
        payload: { kind: 'script', command: 'sleep 30 & sleep 30', timeout_s: 1 },
      }));
      arm('hang');
      const started = Date.now();
      await runner.tick();
      const elapsed = Date.now() - started;

      assert.ok(elapsed < 5000, `took ${elapsed}ms; a backgrounded child must not hold the job open`);
      assert.equal(store.state('hang')?.last_status, 'error');
    });
  });

  describe('a row that will not parse', () => {
    // Corrupt a stored job the way a bad hand-edit or a rolled-back schema
    // change would: the row is intact, the payload is not.
    const corrupt = (id: string): void => {
      store.upsert(job({ id }));
      (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } })
        .db.prepare('UPDATE scheduler_jobs SET payload = ? WHERE id = ?')
        .run('{"kind":"not-a-payload"}', id);
    };

    it('is reported rather than silently dropped', () => {
      corrupt('broken');
      assert.equal(store.list(true).find(j => j.id === 'broken'), undefined,
        'it cannot appear in list() — there is no Job to build');
      const bad = store.unreadable();
      assert.equal(bad.length, 1);
      assert.equal(bad[0].id, 'broken');
      assert.ok(bad[0].error.length > 0, 'the reason travels with it, or it cannot be repaired');
    });

    it('stays reportable after the tick disables it', async () => {
      corrupt('broken');
      arm('broken');
      await runner.tick();
      assert.equal(store.state('broken')?.disabled_reason, 'unreadable');
      assert.equal(store.unreadable().length, 1,
        'disabling stops the log noise; it must not also remove the last trace of the job');
    });

    it('leaves readable jobs alone', () => {
      store.upsert(job({ id: 'fine' }));
      corrupt('broken');
      assert.deepEqual(store.list(true).map(j => j.id), ['fine']);
      assert.deepEqual(store.unreadable().map(u => u.id), ['broken']);
    });
  });
});
