import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProcessTools } from '../tools/ritsu-agent/process.js';
import type { Workspace } from '../workspace-store.js';
import type { RaTool } from '../model/ritsu-agent/types.js';

function findTool(tools: RaTool[], name: string): RaTool {
  const t = tools.find(x => x.name === name);
  if (!t) throw new Error(`tool ${name} not in list`);
  return t;
}

describe('ritsu-agent process tools', () => {
  let dir: string;
  let ws: Workspace[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ra-proc-'));
    ws = [{ id: 1, agent_id: 'a', path: dir, permissions: ['read', 'write', 'exec'], created_at: 0 }];
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  describe('Bash', () => {
    it('runs a command inside the workspace cwd', async () => {
      const Bash = findTool(buildProcessTools(ws), 'Bash');
      const out = await Bash.handler({ command: 'pwd' });
      assert.equal(out.trim(), dir);
    });

    it('captures stderr + exit code on failure', async () => {
      const Bash = findTool(buildProcessTools(ws), 'Bash');
      const out = await Bash.handler({ command: 'echo hello && false' });
      assert.ok((out).includes('hello'));
      assert.ok((out).includes('exit code 1'));
    });

    it('times out and reports it', async () => {
      const Bash = findTool(buildProcessTools(ws), 'Bash');
      const out = await Bash.handler({ command: 'sleep 5', timeout_ms: 200 });
      assert.match(out, /timed out after 200ms/);
    });

    it('denies when workspace lacks exec permission', async () => {
      const readOnly: Workspace[] = [{ ...ws[0], permissions: ['read'] }];
      const Bash = findTool(buildProcessTools(readOnly), 'Bash');
      const out = await Bash.handler({ command: 'pwd' });
      assert.match(out, /^denied:/);
    });

    it('does NOT forward parent-process secrets to the shell', async () => {
      // Plants a canary on every name an attacker would reach for via
      // prompt injection. None should appear in the child's `env` output:
      // a Bash inheriting `process.env` would echo them all.
      const canaries: Record<string, string> = {
        ANTHROPIC_API_KEY:        'CANARY_anthropic',
        OPENAI_API_KEY:           'CANARY_openai',
        RITSU_ADMIN_TOKEN:        'CANARY_admin',
        RITSU_ADMIN_TOKEN_FILE:   'CANARY_admin_path',
        DATABASE_URL:             'CANARY_db',
        AWS_SECRET_ACCESS_KEY:    'CANARY_aws',
      };
      const restore: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(canaries)) {
        restore[k] = process.env[k];
        process.env[k] = v;
      }
      try {
        const Bash = findTool(buildProcessTools(ws), 'Bash');
        const out = await Bash.handler({ command: 'env' });
        for (const value of Object.values(canaries)) {
          assert.ok(!out.includes(value),
            `BASH ENV LEAK: ${value} appeared in child env output:\n${out}`);
        }
        // Sanity-check that the allowlisted vars DO survive — otherwise
        // the test could falsely pass by simply not running the command.
        assert.match(out, /^PATH=/m, 'PATH should be forwarded');
      } finally {
        for (const [k, v] of Object.entries(restore)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });
  });

  describe('Glob', () => {
    beforeEach(() => {
      writeFileSync(join(dir, 'a.ts'), 'x');
      writeFileSync(join(dir, 'b.ts'), 'x');
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src/c.ts'), 'x');
      writeFileSync(join(dir, 'src/d.md'), 'x');
      mkdirSync(join(dir, 'src/sub'), { recursive: true });
      writeFileSync(join(dir, 'src/sub/e.ts'), 'x');
    });

    it('matches single-star (no slash) patterns', async () => {
      const Glob = findTool(buildProcessTools(ws), 'Glob');
      const out = await Glob.handler({ pattern: '*.ts' });
      assert.deepEqual(out.split('\n').sort(), ['a.ts', 'b.ts']);
    });

    it('matches double-star recursive patterns', async () => {
      const Glob = findTool(buildProcessTools(ws), 'Glob');
      const out = await Glob.handler({ pattern: '**/*.ts' });
      const files = out.split('\n').sort();
      assert.ok((files).includes('a.ts'));
      assert.ok((files).includes('src/c.ts'));
      assert.ok((files).includes('src/sub/e.ts'));
      assert.ok(!(files).includes('src/d.md'));
    });

    it('rejects a subdir path outside the workspace', async () => {
      const Glob = findTool(buildProcessTools(ws), 'Glob');
      const out = await Glob.handler({ pattern: '*.ts', path: '../../../etc' });
      assert.match(out, /outside workspace/);
    });
  });

  describe('Grep', () => {
    beforeEach(() => {
      writeFileSync(join(dir, 'a.ts'), 'const x = 1;\nfunction foo() {}\nTODO: nothing\n');
      writeFileSync(join(dir, 'b.md'), '# Title\nTODO: write more\n');
    });

    it('finds matching lines with path:line:text format', async () => {
      const Grep = findTool(buildProcessTools(ws), 'Grep');
      const out = await Grep.handler({ pattern: 'TODO' });
      assert.match(out, /a\.ts:3:TODO/);
      assert.match(out, /b\.md:2:TODO/);
    });

    it('honors include glob to filter file types', async () => {
      const Grep = findTool(buildProcessTools(ws), 'Grep');
      const out = await Grep.handler({ pattern: 'TODO', include: '*.ts' });
      assert.ok((out).includes('a.ts:3'));
      assert.ok(!(out).includes('b.md'));
    });

    it('reports invalid regex cleanly', async () => {
      const Grep = findTool(buildProcessTools(ws), 'Grep');
      const out = await Grep.handler({ pattern: '[unclosed' });
      assert.match(out, /invalid regex/);
    });

    it('reports no matches', async () => {
      const Grep = findTool(buildProcessTools(ws), 'Grep');
      const out = await Grep.handler({ pattern: 'never-found-token' });
      assert.equal(out, '(no matches)');
    });
  });

  describe('symlink-handling in walkers', () => {
    it('Glob does not list symlink entries', async () => {
      writeFileSync(join(dir, 'real.txt'), 'a');
      symlinkSync('/etc/hostname', join(dir, 'shortcut'));
      const Glob = findTool(buildProcessTools(ws), 'Glob');
      const out = await Glob.handler({ pattern: '*' });
      const matches = out.split('\n');
      assert.ok(matches.includes('real.txt'), 'regular file should be listed');
      assert.ok(!matches.includes('shortcut'), 'symlink must not be listed');
    });

    it('Glob refuses a subdir that is a symlink pointing outside the workspace', async () => {
      // Agent points Glob at `proc` which is actually /proc. The lexical
      // containment check passes (still under workspace root by name),
      // but the canonicalization step resolves /proc and rejects.
      symlinkSync('/proc', join(dir, 'proc'));
      const Glob = findTool(buildProcessTools(ws), 'Glob');
      const out = await Glob.handler({ pattern: '*', path: 'proc' });
      assert.match(out, /^error:/);
      assert.ok(!out.includes('self'), 'must not have walked into /proc');
    });

    it('Grep does not surface content from symlinked files', async () => {
      writeFileSync(join(dir, 'in-ws.txt'), 'workspace-marker');
      // External secret the agent should never see via Grep.
      const external = mkdtempSync(join(tmpdir(), 'ra-proc-secret-'));
      try {
        writeFileSync(join(external, 'secret.txt'), 'CANARY_should_never_appear');
        symlinkSync(join(external, 'secret.txt'), join(dir, 'shortcut.txt'));
        const Grep = findTool(buildProcessTools(ws), 'Grep');
        const out = await Grep.handler({ pattern: 'CANARY' });
        assert.ok(!out.includes('CANARY_should_never_appear'),
          'grep must not return content from a symlinked file');
      } finally {
        rmSync(external, { recursive: true, force: true });
      }
    });
  });
});
