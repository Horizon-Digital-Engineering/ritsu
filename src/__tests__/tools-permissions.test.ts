import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { checkToolUse } from '../tools/permissions.js';
import type { Workspace } from '../workspace-store.js';

function ws(path: string, perms: Workspace['permissions']): Workspace {
  return { id: 1, agent_id: 'a', path, permissions: perms, created_at: 0 };
}

describe('checkToolUse', () => {
  it('allows Read on a read workspace covering the file', () => {
    const r = checkToolUse('Read', { file_path: '/tmp/sb/x.txt' }, [ws('/tmp/sb', ['read'])]);
    assert.equal(r.ok, true);
  });

  it('denies Write when the workspace only has read', () => {
    const r = checkToolUse('Write', { file_path: '/tmp/sb/x.txt' }, [ws('/tmp/sb', ['read'])]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /no workspace grants 'write'/);
  });

  it('allows Write when the workspace has write', () => {
    const r = checkToolUse('Write', { file_path: '/tmp/sb/x.txt' }, [ws('/tmp/sb', ['read', 'write'])]);
    assert.equal(r.ok, true);
  });

  it('denies access outside any workspace', () => {
    const r = checkToolUse('Read', { file_path: '/etc/passwd' }, [ws('/tmp/sb', ['read'])]);
    assert.equal(r.ok, false);
  });

  it('Bash uses cwd (workspaces[0]) for the exec check', () => {
    const ok = checkToolUse('Bash', { command: 'ls' }, [ws('/tmp/sb', ['read', 'exec'])]);
    assert.equal(ok.ok, true);
    const deny = checkToolUse('Bash', { command: 'ls' }, [ws('/tmp/sb', ['read'])]);
    assert.equal(deny.ok, false);
  });

  it('WebFetch needs no workspace permission', () => {
    assert.equal(checkToolUse('WebFetch', { url: 'https://example.com' }, []).ok, true);
  });

  it('unknown tool fails closed', () => {
    const r = checkToolUse('Mystery', {}, [ws('/tmp/sb', ['read', 'write', 'exec'])]);
    assert.equal(r.ok, false);
  });

  it('multiple workspaces — first matching one with permission wins', () => {
    const list = [ws('/a', ['read']), ws('/b', ['write'])];
    assert.equal(checkToolUse('Write', { file_path: '/b/file' }, list).ok, true);
    assert.equal(checkToolUse('Write', { file_path: '/a/file' }, list).ok, false);
  });
});
