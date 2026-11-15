import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { formatSummary, formatUptime, healthCommand, runHealth, type Io, type Timing } from '../cli/commands/health.js';
import type { HealthSummary, Part } from '../health/types.js';

const FAST: Timing = { retryMs: 50, settleMs: 400, tryMs: 500 };

function part(id: Part['id'], label: string, status: Part['status'], note: string): Part {
  return { id, label, status, note };
}

function summary(status: HealthSummary['status'], parts: Part[] = []): HealthSummary {
  return { name: 'ritsu', status, version: '0.14.0', uptime_s: 3 * 3600 + 12 * 60, parts };
}

const OK = summary('ok', [
  part('database', 'Database', 'ok', 'open, 812 GB free'),
  part('voice', 'Voice', 'off', 'turned off'),
]);
const WARN = summary('warn', [
  part('database', 'Database', 'ok', 'open, 812 GB free'),
  part('subscription', 'Subscription token', 'warn', 'missing'),
]);
const FAIL = summary('fail', [
  part('database', 'Database', 'ok', 'open, 812 GB free'),
  part('mcp', 'MCP server', 'fail', 'not listening'),
]);

function capture(): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: l => { stdout.push(l); }, err: l => { stderr.push(l); } };
}

type Reply = { status: number; body: string };
const json = (s: HealthSummary): Reply => ({ status: s.status === 'fail' ? 503 : 200, body: JSON.stringify(s) });

interface Fake { base: string; port: number; hits: () => number; close: () => Promise<void> }

const open: Fake[] = [];

async function serve(reply: (hit: number) => Reply, port = 0): Promise<Fake> {
  let hits = 0;
  const server: Server = createServer((req, res) => {
    hits += 1;
    const r = req.url === '/readyz' ? reply(hits) : { status: 404, body: 'not found' };
    res.writeHead(r.status, { 'Content-Type': r.body.startsWith('{') ? 'application/json' : 'text/plain' });
    res.end(r.body);
  });
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  const actual = (server.address() as AddressInfo).port;
  const fake: Fake = {
    base: `http://127.0.0.1:${actual}`,
    port: actual,
    hits: () => hits,
    close: () => new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
  open.push(fake);
  return fake;
}

async function freePort(): Promise<number> {
  const f = await serve(() => ({ status: 200, body: '' }));
  open.splice(open.indexOf(f), 1);
  await f.close();
  return f.port;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map(f => f.close()));
});

describe('formatUptime', () => {
  it('reads in the largest sensible units', () => {
    assert.equal(formatUptime(42), '42 s');
    assert.equal(formatUptime(600), '10 min');
    assert.equal(formatUptime(3 * 3600 + 12 * 60 + 5), '3 h 12 min');
    assert.equal(formatUptime(2 * 86400 + 5 * 3600), '2 d 5 h');
  });
});

describe('formatSummary', () => {
  it('prints a header, one aligned row per part, and the verdict', () => {
    const s = summary('fail', [
      part('database', 'Database', 'ok', 'open, 812 GB free'),
      part('subscription', 'Subscription token', 'warn', 'missing'),
      part('mcp', 'MCP server', 'fail', 'not listening'),
      part('voice', 'Voice', 'off', 'turned off'),
    ]);
    assert.deepEqual(formatSummary(s), [
      'ritsu 0.14.0 · up 3 h 12 min',
      '  ✓  Database            open, 812 GB free',
      '  !  Subscription token  missing',
      '  ✗  MCP server          not listening',
      '  –  Voice               turned off',
      '',
      '  1 failing',
    ]);
  });

  it('says all parts up when nothing is wrong, off parts included', () => {
    assert.equal(formatSummary(OK).at(-1), '  all parts up');
  });

  it('counts warnings with the right plural', () => {
    assert.equal(formatSummary(WARN).at(-1), '  up, 1 warning');
    const two = summary('warn', [...WARN.parts, part('backups', 'Backups', 'warn', 'no daily backup yet')]);
    assert.equal(formatSummary(two).at(-1), '  up, 2 warnings');
  });
});

describe('runHealth', () => {
  it('exits 0 and prints the parts when everything is up', async () => {
    const f = await serve(() => json(OK));
    const io = capture();
    assert.equal(await runHealth({ base: f.base, waitMs: 0, json: false }, io, FAST), 0);
    assert.deepEqual(io.stdout, formatSummary(OK));
    assert.deepEqual(io.stderr, []);
  });

  it('exits 0 on warnings', async () => {
    const f = await serve(() => json(WARN));
    const io = capture();
    assert.equal(await runHealth({ base: f.base, waitMs: 0, json: false }, io, FAST), 0);
    assert.equal(io.stdout.at(-1), '  up, 1 warning');
  });

  it('exits 1 on a failing part, reading the 503 body, after one try without --wait', async () => {
    const f = await serve(() => json(FAIL));
    const io = capture();
    assert.equal(await runHealth({ base: f.base, waitMs: 0, json: false }, io, FAST), 1);
    assert.equal(io.stdout.at(-1), '  1 failing');
    assert.equal(f.hits(), 1);
  });

  it('exits 2 when nothing answers', async () => {
    const port = await freePort();
    const io = capture();
    assert.equal(await runHealth({ base: `http://127.0.0.1:${port}`, waitMs: 0, json: false }, io, FAST), 3);
    assert.deepEqual(io.stdout, []);
    assert.match(io.stderr.join('\n'), /no answer from http:\/\/127\.0\.0\.1:\d+\/readyz \(connection refused\)/);
  });

  it('--wait keeps asking until a late server answers, with one waiting line', async () => {
    const port = await freePort();
    const io = capture();
    const late = new Promise<Fake>(resolve => setTimeout(() => resolve(serve(() => json(OK), port)), 300));
    const code = await runHealth({ base: `http://127.0.0.1:${port}`, waitMs: 5_000, json: false }, io, FAST);
    await late;
    assert.equal(code, 0);
    assert.deepEqual(io.stdout, formatSummary(OK));
    assert.equal(io.stderr.length, 1);
    assert.match(io.stderr[0], /waiting for ritsu at http:\/\/127\.0\.0\.1:\d+ \(up to 5 s\)/);
  });

  it('--wait gives up with exit 2 when the time runs out', async () => {
    const port = await freePort();
    const io = capture();
    const started = Date.now();
    assert.equal(await runHealth({ base: `http://127.0.0.1:${port}`, waitMs: 1_000, json: false }, io, FAST), 3);
    assert.ok(Date.now() - started < 3_000);
    assert.equal(io.stderr.length, 2);
    assert.match(io.stderr[1], /no answer from .*\/readyz within 1 s \(connection refused\)/);
  });

  it('with time left, a failing answer is asked again until the parts settle', async () => {
    const f = await serve(hit => json(hit < 3 ? FAIL : OK));
    const io = capture();
    assert.equal(await runHealth({ base: f.base, waitMs: 5_000, json: false }, io, FAST), 0);
    assert.equal(f.hits(), 3);
    assert.deepEqual(io.stdout, formatSummary(OK));
    assert.match(io.stderr[0], /a part is failing; checking again/);
  });

  it('settling is bounded: a part that stays failing exits 1 well before --wait ends', async () => {
    const f = await serve(() => json(FAIL));
    const io = capture();
    const started = Date.now();
    assert.equal(await runHealth({ base: f.base, waitMs: 10_000, json: false }, io, FAST), 1);
    const took = Date.now() - started;
    assert.ok(took >= FAST.settleMs && took < 3_000, `took ${took} ms`);
    assert.ok(f.hits() > 1);
    assert.equal(io.stdout.at(-1), '  1 failing');
  });

  it('--json prints the summary as received', async () => {
    const f = await serve(() => json(WARN));
    const io = capture();
    assert.equal(await runHealth({ base: f.base, waitMs: 0, json: true }, io, FAST), 0);
    assert.equal(io.stdout.length, 1);
    assert.deepEqual(JSON.parse(io.stdout[0]), WARN);
  });

  it('a non-JSON answer is no answer (exit 2)', async () => {
    const f = await serve(() => ({ status: 200, body: 'ok' }));
    const io = capture();
    assert.equal(await runHealth({ base: f.base, waitMs: 0, json: false }, io, FAST), 3);
    assert.match(io.stderr.join('\n'), /HTTP 200, not a health summary/);
  });

  it('JSON that is not a health summary is no answer either', async () => {
    const f = await serve(() => ({ status: 200, body: JSON.stringify({ status: 'ready', name: 'ritsu', agents_loaded: 3 }) }));
    const io = capture();
    assert.equal(await runHealth({ base: f.base, waitMs: 0, json: true }, io, FAST), 3);
    assert.deepEqual(io.stdout, []);
  });
});

describe('ritsu health (flags)', () => {
  it('rejects a --wait that is not whole seconds with exit 2', async (t) => {
    const errors: string[] = [];
    t.mock.method(console, 'error', (l: string) => { errors.push(l); });
    for (const wait of [true, 'soon', '-5', '1.5']) {
      assert.equal(await healthCommand.run({ subcommand: null, positional: [], flags: { wait } }), 2);
    }
    assert.equal(errors.length, 4);
  });

  it('asks the --url base and honours --json', async (t) => {
    const f = await serve(() => json(OK));
    const lines: string[] = [];
    t.mock.method(console, 'log', (l: string) => { lines.push(l); });
    assert.equal(await healthCommand.run({ subcommand: null, positional: [], flags: { url: `${f.base}/`, json: true } }), 0);
    assert.deepEqual(JSON.parse(lines.join('\n')), OK);
  });
});
