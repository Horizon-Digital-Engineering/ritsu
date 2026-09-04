/**
 * Ownership rules for agent-created jobs. Both scheduling surfaces (the native
 * tool loop and the in-process MCP server) call these, so getting them right
 * here is what stops the two drifting.
 *
 * The rule: a job an agent created is owned `agent:<id>`, and nothing else may
 * touch it. Scheduling is the most durable thing an agent can do to itself — a
 * job feeds text back as a user turn on a timer and outlives the conversation
 * — so an agent reaching another agent's (or the operator's) jobs matters.
 */
import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { SqliteJobStore } from '../scheduler/store.js';
import { createJob, listJobs, removeJob, pauseJob } from '../scheduler/agent-ops.js';

describe('scheduler agent-ops ownership', () => {
  let store: SqliteJobStore;

  beforeEach(() => { store = new SqliteJobStore(openDatabase(':memory:')); });

  const mk = (agent: string, id: string, over: Partial<Parameters<typeof createJob>[2]> = {}) =>
    createJob(store, agent, {
      id, name: `job ${id}`, kind: 'every', spec: '30m',
      payload: 'notify', message: 'ping', ...over,
    });

  it('creates a job owned by its agent and arms it', () => {
    assert.match(mk('alice', 'daily'), /^Scheduled\./);
    const job = store.read('daily');
    assert.equal(job?.owner, 'agent:alice');
    assert.ok(store.state('daily')?.next_run_at, 'an unarmed job is invisible to the runner');
  });

  it('files an agent_turn job against the creating agent, not a caller-supplied id', () => {
    mk('alice', 'checkin', { payload: 'agent_turn', message: 'how are we doing' });
    const payload = store.read('checkin')?.payload as { kind: string; agent_id: string };
    assert.equal(payload.kind, 'agent_turn');
    assert.equal(payload.agent_id, 'alice');
  });

  it('never lets an agent create a script payload', () => {
    // Arbitrary commands on a timer is a blast radius an agent should not open.
    mk('alice', 'shell', { payload: 'notify', message: 'rm -rf /' });
    assert.equal((store.read('shell')?.payload as { kind: string }).kind, 'notify');
  });

  it('REFUSES to overwrite a job owned by someone else', () => {
    mk('alice', 'shared');
    const out = mk('mallory', 'shared');
    assert.match(out, /not yours/);
    assert.equal(store.read('shared')?.owner, 'agent:alice', 'the owner must not be reassigned');
  });

  it('lets the owner update its own job in place', () => {
    mk('alice', 'mine');
    assert.match(mk('alice', 'mine', { spec: '1d' }), /^Scheduled\./);
    assert.equal(store.read('mine')?.schedule.spec, '1d');
  });

  it('refuses a schedule that can never fire, instead of storing a dead row', () => {
    assert.match(mk('alice', 'never', { kind: 'at', spec: '1999-01-01T00:00:00Z' }), /never fire/);
    assert.equal(store.read('never'), null);
  });

  it('reports a malformed spec rather than throwing at the model', () => {
    const out = mk('alice', 'bad', { kind: 'cron', spec: 'not a cron' });
    assert.match(out, /Refused|Could not schedule/);
  });

  it("lists only the caller's own jobs by default", () => {
    mk('alice', 'a1');
    mk('bob', 'b1');
    const mine = listJobs(store, 'alice');
    assert.match(mine, /a1/);
    assert.ok(!mine.includes('b1'), "enumerating every job hands over a map of the operator's automation");
  });

  it('says so plainly when the caller has no jobs', () => {
    mk('bob', 'b1');
    assert.equal(listJobs(store, 'alice'), 'No scheduled jobs.');
  });

  it("refuses to remove another agent's job, and leaves it intact", () => {
    mk('alice', 'a1');
    assert.match(removeJob(store, 'mallory', 'a1'), /not created by you/);
    assert.ok(store.read('a1'), 'the job must survive the refused remove');
  });

  it("removes the caller's own job", () => {
    mk('alice', 'a1');
    assert.match(removeJob(store, 'alice', 'a1'), /Removed/);
    assert.equal(store.read('a1'), null);
  });

  it("refuses to pause another agent's job", () => {
    mk('alice', 'a1');
    assert.match(pauseJob(store, 'mallory', 'a1', false), /not created by you/);
    assert.ok(store.state('a1')?.next_run_at, 'the victim job must stay armed');
  });

  it('pausing disarms, resuming re-arms', () => {
    mk('alice', 'a1');
    assert.match(pauseJob(store, 'alice', 'a1', false), /Paused/);
    assert.equal(store.state('a1')?.next_run_at, null);
    // setEnabled alone cannot know what clock to schedule against, so a resume
    // that does not re-arm leaves the job silently inert.
    assert.match(pauseJob(store, 'alice', 'a1', true), /^Resumed\./);
    assert.ok(store.state('a1')?.next_run_at, 'resume must re-arm');
  });

  it('reports a missing job rather than pretending', () => {
    assert.match(removeJob(store, 'alice', 'ghost'), /No job/);
    assert.match(pauseJob(store, 'alice', 'ghost', false), /No job/);
  });
});
