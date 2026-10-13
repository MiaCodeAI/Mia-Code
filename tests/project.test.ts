import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  excludedDirReason,
  excludedFileReason,
  excludedPathReason,
} from '../src/project/exclusions.js';
import { buildSnapshot, renderSnapshot } from '../src/project/snapshot.js';
import { runCommand } from '../src/platform/exec.js';

describe('exclusions', () => {
  it('excludes secret-bearing files but keeps env templates and ordinary source', () => {
    for (const name of [
      '.env',
      '.env.local',
      '.env.production',
      'id_rsa',
      'server.pem',
      'private.key',
      '.npmrc',
      'credentials.json',
      'service-account-prod.json',
      'terraform.tfstate',
    ]) {
      expect(excludedFileReason(name), name).toBe('secret');
    }
    for (const name of [
      '.env.example',
      '.env.sample',
      'tokenizer.ts',
      'password_policy.md',
      'auth.ts',
      'README.md',
    ]) {
      expect(excludedFileReason(name), name).toBeNull();
    }
  });

  it('excludes dependency, build, cache and VCS directories and binaries', () => {
    expect(excludedDirReason('node_modules')).toBe('dependency');
    expect(excludedDirReason('.git')).toBe('vcs');
    expect(excludedDirReason('dist')).toBe('build-output');
    expect(excludedDirReason('src')).toBeNull();
    expect(excludedFileReason('logo.PNG')).toBe('binary');
  });

  it('checks every segment of a path', () => {
    expect(excludedPathReason('src/app/main.ts')).toBeNull();
    expect(excludedPathReason('node_modules/x/index.js')).toBe('dependency');
    expect(excludedPathReason('config/prod/.env')).toBe('secret');
    expect(excludedPathReason('a/.git/config')).toBe('vcs');
  });
});

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function project(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mia-proj-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
  return dir;
}

describe('buildSnapshot', () => {
  it('describes a plain folder without leaking secrets or dependencies', async () => {
    const dir = await project({
      'package.json': '{}',
      'README.md': '# Demo\nUse key sk-abcdefghijklmnopqrstuvwx to test.',
      'src/index.ts': 'x',
      '.env': 'SECRET=1',
      'node_modules/dep/index.js': 'x',
      'certs/server.pem': 'x',
      'logo.png': 'x',
    });
    const snap = await buildSnapshot(dir, runCommand, { env: process.env });
    const text = renderSnapshot(snap);
    expect(text).toContain('src/index.ts');
    expect(text).toContain('package.json');
    expect(text).not.toContain('.env');
    expect(text).not.toContain('node_modules');
    expect(text).not.toContain('server.pem');
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(text).toContain('Start of README.md');
    expect(snap.excludedCount).toBeGreaterThanOrEqual(4);
  });

  it('never follows symlinks out of the project', async () => {
    const outside = await project({ 'secret.txt': 'top secret' });
    const dir = await project({ 'a.ts': 'x' });
    try {
      await fs.symlink(outside, path.join(dir, 'link'));
    } catch {
      return; // symlinks unavailable on this platform
    }
    const text = renderSnapshot(await buildSnapshot(dir, runCommand, { env: process.env }));
    expect(text).not.toContain('secret.txt');
  });

  it('uses git, honours .gitignore and reports branch and changes', async () => {
    const dir = await project({
      'a.ts': 'x',
      'ignored/big.ts': 'x',
      '.gitignore': 'ignored/\n',
      '.env': 'S=1',
    });
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
      git('init', '-q', '-b', 'trunk');
      git('add', '-A');
      git(
        '-c',
        'user.email=t@t',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '-m',
        'init',
        '--no-gpg-sign',
      );
    } catch {
      return; // git not installed
    }
    await fs.writeFile(path.join(dir, 'new.ts'), 'y');
    const snap = await buildSnapshot(dir, runCommand, { env: process.env });
    expect(snap.git?.branch).toBe('trunk');
    expect(snap.git?.changedPaths).toBe(1);
    const text = renderSnapshot(snap);
    expect(text).toContain('a.ts');
    expect(text).toContain('new.ts');
    expect(text).not.toContain('ignored/');
    expect(text).not.toMatch(/\.env\b(?!\.)/);
    expect(text).toContain('branch trunk');
  });

  it('truncates very large trees', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) files[`f${i}.ts`] = 'x';
    const snap = await buildSnapshot(await project(files), runCommand, {
      maxEntries: 10,
      env: process.env,
    });
    expect(snap.entries).toHaveLength(10);
    expect(snap.truncated).toBe(true);
  });
});
