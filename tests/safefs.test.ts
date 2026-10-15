import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Checkpoints } from '../src/agent/checkpoints.js';
import { ALL_TOOLS, toolByName, type ToolEnv } from '../src/agent/tools.js';
import type { Runner } from '../src/platform/exec.js';
import {
  UnsafePathError,
  readFileSafe,
  removeFileSafe,
  writeFileSafe,
} from '../src/platform/safefs.js';
import { RepoIndex } from '../src/repo/index.js';

const noRun: Runner = async () => ({
  exitCode: 1,
  stdout: '',
  stderr: '',
  timedOut: false,
  truncated: false,
});
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
async function tmp(files: Record<string, string> = {}): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mia-safe-')));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
  return dir;
}
const symlinksWork = async (): Promise<boolean> => {
  const d = await tmp();
  try {
    await fs.symlink(d, path.join(d, 'l'));
    return true;
  } catch {
    return false;
  }
};

describe('symlink-safe file operations', () => {
  it('writes, creates directories, reads and removes plain files', async () => {
    const root = await tmp({ 'a.txt': 'old' });
    await writeFileSafe(root, 'a.txt', 'new', { mustExist: true });
    await writeFileSafe(root, 'x/y/z.txt', 'deep', { mustExist: false });
    expect(await readFileSafe(root, 'a.txt')).toBe('new');
    expect(await readFileSafe(root, 'x/y/z.txt')).toBe('deep');
    expect(await readFileSafe(root, 'missing.txt')).toBeNull();
    expect(await removeFileSafe(root, 'x/y/z.txt')).toBe(true);
    expect(await removeFileSafe(root, 'x/y/z.txt')).toBe(false);
    await expect(writeFileSafe(root, 'a.txt', 'again', { mustExist: false })).rejects.toThrow();
    await expect(writeFileSafe(root, '../escape.txt', 'x')).rejects.toBeInstanceOf(UnsafePathError);
  });

  it('refuses symlinked files and directories', async () => {
    if (!(await symlinksWork())) return;
    const outside = await tmp({ 'target.txt': 'precious' });
    const root = await tmp({ 'a.txt': 'x' });
    await fs.symlink(path.join(outside, 'target.txt'), path.join(root, 'link.txt'));
    await fs.symlink(outside, path.join(root, 'linkdir'));
    await expect(writeFileSafe(root, 'link.txt', 'pwned')).rejects.toThrow();
    await expect(writeFileSafe(root, 'linkdir/new.txt', 'pwned')).rejects.toThrow();
    await expect(readFileSafe(root, 'link.txt')).rejects.toThrow();
    await expect(readFileSafe(root, 'linkdir/target.txt')).rejects.toThrow();
    await expect(removeFileSafe(root, 'link.txt')).rejects.toThrow();
    expect(await fs.readFile(path.join(outside, 'target.txt'), 'utf8')).toBe('precious');
    await expect(fs.access(path.join(outside, 'new.txt'))).rejects.toThrow();
  });

  it('a directory swapped for a symlink after validation cannot redirect the write', async () => {
    if (!(await symlinksWork())) return;
    const outside = await tmp({ 'f.txt': 'precious' });
    const root = await tmp({ 'sub/f.txt': 'inside' });
    // Swap before the directory walk: the walk refuses.
    await expect(
      writeFileSafe(root, 'sub/f.txt', 'pwned', {
        mustExist: true,
        between: async (stage) => {
          if (stage !== 'before-walk') return;
          await fs.rename(path.join(root, 'sub'), path.join(root, 'sub.orig'));
          await fs.symlink(outside, path.join(root, 'sub'));
        },
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(outside, 'f.txt'), 'utf8')).toBe('precious');
    await fs.rm(path.join(root, 'sub'));
    await fs.rename(path.join(root, 'sub.orig'), path.join(root, 'sub'));

    // Swap after the directory was verified: on Linux the write stays anchored to the real directory.
    if (process.platform !== 'linux') return;
    await writeFileSafe(root, 'sub/f.txt', 'safe', {
      mustExist: true,
      between: async (stage) => {
        if (stage !== 'before-open') return;
        await fs.rename(path.join(root, 'sub'), path.join(root, 'sub.moved'));
        await fs.symlink(outside, path.join(root, 'sub'));
      },
    });
    expect(await fs.readFile(path.join(outside, 'f.txt'), 'utf8')).toBe('precious');
    expect(await fs.readFile(path.join(root, 'sub.moved', 'f.txt'), 'utf8')).toBe('safe');
  });

  it('edit_file refuses to overwrite a file that changed between planning and writing', async () => {
    const root = await tmp({ 'a.txt': 'one\n' });
    const index = new RepoIndex(root, noRun, {});
    await index.refresh();
    const env: ToolEnv = {
      root,
      index,
      run: noRun,
      env: {},
      platform: 'linux',
      checkpoints: new Checkpoints(root),
      beforeCommit: async () => {
        await fs.writeFile(path.join(root, 'a.txt'), 'edited by someone else\n');
      },
    };
    const result = await toolByName('edit_file')!.execute(
      { path: 'a.txt', old_string: 'one', new_string: 'two' },
      env,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/changed since it was read/);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('edited by someone else\n');
    expect(ALL_TOOLS.length).toBeGreaterThan(5);
  });

  it('undo does not follow a symlink planted where the agent wrote', async () => {
    if (!(await symlinksWork())) return;
    const outside = await tmp({ 'victim.txt': 'precious' });
    const root = await tmp({ 'a.txt': 'one\n' });
    const index = new RepoIndex(root, noRun, {});
    await index.refresh();
    const cp = new Checkpoints(root);
    const env: ToolEnv = { root, index, run: noRun, env: {}, platform: 'linux', checkpoints: cp };
    cp.begin('t');
    await toolByName('write_file')!.execute({ path: 'new.txt', content: 'created\n' }, env);
    // Replace the created file with a symlink to a file outside the project.
    await fs.rm(path.join(root, 'new.txt'));
    await fs.symlink(path.join(outside, 'victim.txt'), path.join(root, 'new.txt'));
    const result = await cp.undoLast();
    expect(result?.conflicts).toEqual(['new.txt']);
    expect(await fs.readFile(path.join(outside, 'victim.txt'), 'utf8')).toBe('precious');
  });
});

describe('repo index freshness', () => {
  it('sees every same-size edit made in quick succession', async () => {
    const root = await tmp({ 'a.ts': 'export function aaa1() {}\n' });
    const index = new RepoIndex(root, noRun, {});
    await index.refresh();
    for (let i = 2; i <= 25; i++) {
      await fs.writeFile(
        path.join(root, 'a.ts'),
        `export function aaa${String(i).padStart(1, '0')}() {}\n`.replace(
          /aaa(\d)\(/,
          (_m, d: string) => `aaa${d}(`,
        ),
      );
      await index.refresh();
      const names = index.allSymbols().map((s) => s.name);
      expect(
        names.some((n) => n === `aaa${i}`),
        `iteration ${i}: ${names.join()}`,
      ).toBe(true);
    }
  });

  it('re-reads files modified right before the scan on the next refresh (racy timestamps)', async () => {
    const root = await tmp({ 'a.ts': 'export function one() {}\n' });
    const index = new RepoIndex(root, noRun, {});
    await index.refresh();
    expect(index.lastRefreshReads).toBe(1);
    await index.refresh(); // file is still "racy" (just written): read again once
    expect(index.lastRefreshReads).toBe(1);
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(path.join(root, 'a.ts'), old, old);
    await index.refresh(); // timestamp changed: read again, now old enough to trust
    await index.refresh();
    expect(index.lastRefreshReads).toBe(0);
  });
});
