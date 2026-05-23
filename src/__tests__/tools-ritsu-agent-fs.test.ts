import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFsTools } from '../tools/ritsu-agent/fs.js';
import type { Workspace } from '../workspace-store.js';
import type { RaTool } from '../model/ritsu-agent/types.js';

function findTool(tools: RaTool[], name: string): RaTool {
  const t = tools.find(x => x.name === name);
  if (!t) throw new Error(`tool ${name} not in list`);
  return t;
}

describe('ritsu-agent FS tools', () => {
  let dir: string;
  let outsideDir: string;
  let ws: Workspace[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ra-fs-'));
    outsideDir = mkdtempSync(join(tmpdir(), 'ra-fs-outside-'));
    ws = [{ id: 1, agent_id: 'a', path: dir, permissions: ['read', 'write', 'exec'], created_at: 0 }];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  describe('Read', () => {
    it('reads a file inside the workspace + returns line-numbered content', async () => {
      writeFileSync(join(dir, 'hello.txt'), 'line one\nline two\nline three');
      const Read = findTool(buildFsTools(ws), 'Read');
      const out = await Read.handler({ file_path: 'hello.txt' });
      assert.ok((out).includes('     1\tline one'));
      assert.ok((out).includes('     2\tline two'));
      assert.ok((out).includes('     3\tline three'));
    });

    it('honors offset + limit', async () => {
      writeFileSync(join(dir, 'big.txt'), Array.from({ length: 100 }, (_, i) => `row ${i}`).join('\n'));
      const Read = findTool(buildFsTools(ws), 'Read');
      const out = await Read.handler({ file_path: 'big.txt', offset: 50, limit: 3 });
      assert.ok((out).includes('    51\trow 50'));
      assert.ok((out).includes('    53\trow 52'));
      assert.ok(!(out).includes('row 53'));
    });

    it('denies reading a file outside the workspace', async () => {
      const outside = join(outsideDir, 'secret.txt');
      writeFileSync(outside, 'classified');
      const Read = findTool(buildFsTools(ws), 'Read');
      const out = await Read.handler({ file_path: outside });
      assert.match(out, /^denied:/);
    });

    it('denies when the workspace lacks read permission', async () => {
      const wsExecOnly: Workspace[] = [{ ...ws[0], permissions: ['exec'] }];
      writeFileSync(join(dir, 'a.txt'), 'x');
      const Read = findTool(buildFsTools(wsExecOnly), 'Read');
      const out = await Read.handler({ file_path: 'a.txt' });
      assert.match(out, /^denied:/);
    });

    it('error message on missing file', async () => {
      const Read = findTool(buildFsTools(ws), 'Read');
      const out = await Read.handler({ file_path: 'no-such-file.txt' });
      assert.match(out, /^error:/);
    });
  });

  describe('Write', () => {
    it('writes a file inside the workspace + creates parent dirs', async () => {
      const Write = findTool(buildFsTools(ws), 'Write');
      const out = await Write.handler({ file_path: 'nested/sub/dir/note.md', content: 'hello' });
      assert.match(out, /wrote 5 bytes/);
      assert.equal(readFileSync(join(dir, 'nested/sub/dir/note.md'), 'utf8'), 'hello');
    });

    it('denies writing outside the workspace', async () => {
      const Write = findTool(buildFsTools(ws), 'Write');
      const out = await Write.handler({ file_path: join(outsideDir, 'sneaky.txt'), content: 'x' });
      assert.match(out, /^denied:/);
      assert.equal(existsSync(join(outsideDir, 'sneaky.txt')), false);
    });
  });

  describe('Edit', () => {
    it('replaces a unique occurrence', async () => {
      writeFileSync(join(dir, 'src.ts'), 'const x = 1;\nconst y = 2;\n');
      const Edit = findTool(buildFsTools(ws), 'Edit');
      const out = await Edit.handler({ file_path: 'src.ts', old_string: 'x = 1', new_string: 'x = 42' });
      assert.match(out, /^edited/);
      assert.equal(readFileSync(join(dir, 'src.ts'), 'utf8'), 'const x = 42;\nconst y = 2;\n');
    });

    it('errors when old_string appears multiple times (forces uniqueness)', async () => {
      writeFileSync(join(dir, 'src.ts'), 'foo\nfoo\nfoo\n');
      const Edit = findTool(buildFsTools(ws), 'Edit');
      const out = await Edit.handler({ file_path: 'src.ts', old_string: 'foo', new_string: 'bar' });
      assert.match(out, /appears 3 times/);
      assert.equal(readFileSync(join(dir, 'src.ts'), 'utf8'), 'foo\nfoo\nfoo\n');
    });

    it('errors when old_string not found', async () => {
      writeFileSync(join(dir, 'src.ts'), 'foo\n');
      const Edit = findTool(buildFsTools(ws), 'Edit');
      const out = await Edit.handler({ file_path: 'src.ts', old_string: 'nope', new_string: 'x' });
      assert.match(out, /not found/);
    });
  });

  describe('symlink escape attempts', () => {
    it('Read denies a symlink in the workspace that points outside', async () => {
      // The classic exfil shape: agent has Write somewhere, drops a
      // symlink to /etc/shadow inside its workspace, then Reads it.
      // Without realpath canonicalization this returns /etc/shadow's
      // content. With it, realpath resolves outside the workspace and
      // containment fails.
      const secret = join(outsideDir, 'secret.txt');
      writeFileSync(secret, 'classified');
      symlinkSync(secret, join(dir, 'escape'));
      const Read = findTool(buildFsTools(ws), 'Read');
      const out = await Read.handler({ file_path: 'escape' });
      assert.match(out, /^denied:/, `expected denial, got: ${out}`);
      assert.ok(!out.includes('classified'), 'must not return target file content');
    });

    it('Read denies a symlink that resolves to /etc/passwd', async () => {
      // /etc/passwd is reliably present on Linux and not in any reasonable
      // workspace. Belt-and-suspenders test that the deny-by-realpath
      // works for system files, not just sibling tmpdirs.
      symlinkSync('/etc/passwd', join(dir, 'passwd'));
      const Read = findTool(buildFsTools(ws), 'Read');
      const out = await Read.handler({ file_path: 'passwd' });
      assert.match(out, /^denied:/);
      assert.ok(!out.includes('root:'), 'must not return /etc/passwd contents');
    });

    it('Write refuses to write through an existing symlink', async () => {
      // Agent has Write on the workspace, but a pre-existing symlink at
      // workspace/log -> /tmp/some-external-file means writeFile would
      // CLOBBER the symlink target. assertNotSymlink stops this.
      const externalTarget = join(outsideDir, 'external-file.txt');
      writeFileSync(externalTarget, 'original-content');
      symlinkSync(externalTarget, join(dir, 'log'));
      const Write = findTool(buildFsTools(ws), 'Write');
      const out = await Write.handler({ file_path: 'log', content: 'overwritten' });
      assert.match(out, /^denied:/);
      assert.equal(readFileSync(externalTarget, 'utf8'), 'original-content',
        'external file must not have been written through the symlink');
      // The symlink itself stays — we refused to operate on it at all.
      assert.ok(lstatSync(join(dir, 'log')).isSymbolicLink());
    });

    it('Read denies pseudo-fs paths even if a workspace covers them', async () => {
      // Construct a hypothetical workspace that covers /proc. checkToolUse
      // should reject the read regardless because /proc is in the
      // pseudo-fs deny-list.
      const procWs: Workspace[] = [
        { id: 99, agent_id: 'a', path: '/proc', permissions: ['read'], created_at: 0 },
      ];
      const Read = findTool(buildFsTools(procWs), 'Read');
      const out = await Read.handler({ file_path: '/proc/self/cmdline' });
      assert.match(out, /^denied:/);
      assert.ok(/pseudo-filesystem|deny/.test(out), `expected pseudo-fs deny, got: ${out}`);
    });
  });
});
