/**
 * Targeted tests for `resolveWorkspaceTarget` — the workspace-creation
 * helper that turns a request body into an absolute filesystem target.
 * Defends against path-traversal attempts via the `subpath` parameter,
 * normalises the result, and rejects bodies that don't supply either
 * shape ({root, subpath} or {path}).
 *
 * The helper writes errors to a `res.status(400).json(...)` shape, so
 * we feed it a tiny capturing fake Response and assert against what
 * the route would have sent back.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { resolveWorkspaceTarget } from '../admin/server.js';

/** Minimal Response stand-in: captures the last status() + json() call. */
interface FakeResCapture {
  readonly status: number | null;
  readonly body: unknown;
  readonly res: { status(c: number): { json(b: unknown): void } };
}
function fakeRes(): FakeResCapture {
  const state: { status: number | null; body: unknown } = { status: null, body: null };
  const res = {
    status(c: number) {
      state.status = c;
      return { json(b: unknown) { state.body = b; } };
    },
  };
  return {
    get status() { return state.status; },
    get body() { return state.body; },
    res,
  };
}

describe('resolveWorkspaceTarget — legacy {path} shape', () => {
  it('returns the absolute path verbatim when given an absolute path', () => {
    const r = fakeRes();
    const out = resolveWorkspaceTarget({ path: '/srv/projects/foo' }, r.res as never);
    assert.equal(out, '/srv/projects/foo');
    assert.equal(r.status, null);
  });

  it('normalises `..` segments inside the path', () => {
    const r = fakeRes();
    const out = resolveWorkspaceTarget({ path: '/srv/projects/../projects/foo' }, r.res as never);
    assert.equal(out, '/srv/projects/foo');
  });

  it('rejects an empty body (no path, no root)', () => {
    const r = fakeRes();
    const out = resolveWorkspaceTarget({}, r.res as never);
    assert.equal(out, null);
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.body), /required/);
  });
});

describe('resolveWorkspaceTarget — picker {root, subpath} shape', () => {
  it('joins root + subpath and returns absolute', () => {
    const r = fakeRes();
    const out = resolveWorkspaceTarget(
      { root: '/srv/agent-zones', subpath: 'researcher' },
      r.res as never,
    );
    assert.equal(out, '/srv/agent-zones/researcher');
  });

  it('returns just the root when subpath is empty', () => {
    const r = fakeRes();
    const out = resolveWorkspaceTarget(
      { root: '/srv/agent-zones', subpath: '' },
      r.res as never,
    );
    assert.equal(out, '/srv/agent-zones');
  });

  it('strips leading slashes from the subpath (subpath is always relative to root)', () => {
    const r = fakeRes();
    const out = resolveWorkspaceTarget(
      { root: '/srv/agent-zones', subpath: '/researcher' },
      r.res as never,
    );
    assert.equal(out, '/srv/agent-zones/researcher');
  });

  it('rejects a subpath that traverses outside the root via ..', () => {
    const r = fakeRes();
    const out = resolveWorkspaceTarget(
      { root: '/srv/agent-zones', subpath: '../../etc/passwd' },
      r.res as never,
    );
    assert.equal(out, null);
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.body), /traversal/);
  });

  it('rejects a subpath that resolves to the parent of root via .. chains', () => {
    const r = fakeRes();
    const out = resolveWorkspaceTarget(
      { root: '/srv/agent-zones/researcher', subpath: '../../escape' },
      r.res as never,
    );
    assert.equal(out, null);
    assert.equal(r.status, 400);
  });

  it('rejects a subpath that uses `..` to climb then re-enter — combined attack', () => {
    const r = fakeRes();
    // Looks like it stays inside `agent-zones/researcher` but the resolved
    // path is /srv/other (escapes the prefix check).
    const out = resolveWorkspaceTarget(
      { root: '/srv/agent-zones/researcher', subpath: '../../../etc/passwd' },
      r.res as never,
    );
    assert.equal(out, null);
    assert.equal(r.status, 400);
  });

  it('accepts a nested subpath that stays inside root', () => {
    const r = fakeRes();
    const out = resolveWorkspaceTarget(
      { root: '/srv/agent-zones', subpath: 'researcher/2026/notes' },
      r.res as never,
    );
    assert.equal(out, '/srv/agent-zones/researcher/2026/notes');
  });
});

describe('resolveWorkspaceTarget — flat path edge cases', () => {
  it('rejects only when path AND root are both missing', () => {
    const r = fakeRes();
    const out = resolveWorkspaceTarget({ subpath: 'foo' }, r.res as never);
    // subpath alone (no root, no path) is invalid — caught upstream by
    // the zod schema, but resolveWorkspaceTarget defensively rejects too.
    assert.equal(out, null);
    assert.equal(r.status, 400);
  });
});
