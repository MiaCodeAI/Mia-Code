import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it as test } from 'vitest';
import { runShell } from '../src/agent/tools.js';
import type { ToolEnv } from '../src/agent/tools.js';
import { runCommand } from '../src/platform/exec.js';
import {
  bwrapArgs,
  dockerArgs,
  seatbeltProfile,
  type WrapOptions,
} from '../src/sandbox/backends.js';
import { chooseSandbox, defaultSandboxConfig, probeBackends } from '../src/sandbox/index.js';

const opts = (over: Partial<WrapOptions> = {}): WrapOptions => ({
  root: '/work/proj',
  network: 'off',
  writable: [],
  hide: ['/work/proj/.env'],
  home: '/home/u',
  platform: 'linux',
  homeToolDirs: [],
  ...over,
});

test('bwrap args: read-only root, writable project, hidden home, no network, secrets masked', () => {
  const { command, args } = bwrapArgs(['/bin/sh', '-c', 'x'], opts());
  expect(command).toBe('bwrap');
  const joined = args.join(' ');
  expect(joined).toMatch(/--ro-bind \/ \//);
  expect(joined).toMatch(/--bind \/work\/proj \/work\/proj/);
  expect(joined).toMatch(/--tmpfs \/home\/u/);
  expect(joined).toMatch(/--ro-bind \/dev\/null \/work\/proj\/\.env/);
  expect(args.includes('--unshare-net')).toBe(true);
  expect(args.includes('--die-with-parent')).toBe(true);
  expect(args.slice(-3)).toEqual(['/bin/sh', '-c', 'x']);
  expect(bwrapArgs(['true'], opts({ network: 'on' })).args.includes('--unshare-net')).toBe(false);
});

test('seatbelt profile denies by default and limits writes', () => {
  const p = seatbeltProfile(opts({ platform: 'darwin' }));
  expect(p).toMatch(/\(deny default\)/);
  expect(p).toMatch(/deny file-read\* \(subpath "\/home\/u\/\.ssh"\)/);
  expect(p).toMatch(/deny file-read\* \(literal "\/work\/proj\/\.env"\)/);
  expect(p).not.toMatch(/allow network/);
  expect(seatbeltProfile(opts({ network: 'on' }))).toMatch(/allow network\*/);
});

test('docker args: no network by default, mounts only the project, needs an image', () => {
  expect(() => dockerArgs(['sh'], opts())).toThrow(/needs an image/);
  const { args } = dockerArgs(['sh', '-c', 'x'], opts({ image: 'node:20', uid: 1000, gid: 1000 }));
  expect(args[args.indexOf('--network') + 1]).toBe('none');
  expect(args.includes('/work/proj:/workspace:rw')).toBe(true);
  expect(args.includes('/dev/null:/workspace/.env:ro')).toBe(true);
  expect(args.includes('1000:1000')).toBe(true);
});

test('chooseSandbox reports why none is available', async () => {
  const none = async () => ({
    exitCode: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    truncated: false,
    error: new Error('ENOENT'),
  });
  const c = await chooseSandbox(none, 'win32', defaultSandboxConfig(), '/p', []);
  expect(c.sandbox).toBe(null);
  expect(c.reason ?? '').toMatch(/Windows/);
  const off = await chooseSandbox(
    none,
    'linux',
    { ...defaultSandboxConfig(), mode: 'off' },
    '/p',
    [],
  );
  expect(off.reason ?? '').toMatch(/disabled/);
});

test('runShell wraps commands when a sandbox is active', async () => {
  const calls: Array<[string, readonly string[]]> = [];
  const env = {
    root: '/work/proj',
    platform: 'linux',
    env: {},
    run: async (c: string, a: readonly string[]) => {
      calls.push([c, a]);
      return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, truncated: false };
    },
    sandbox: { wrap: (s: readonly string[]) => ({ command: 'bwrap', args: ['--x', ...s] }) },
  } as unknown as ToolEnv;
  await runShell('echo hi', env, 1000);
  expect(calls[0]?.[0]).toBe('bwrap');
  expect(calls[0]?.[1]).toEqual(['--x', '/bin/sh', '-c', 'echo hi']);
});

const bwrapOk =
  (await probeBackends(runCommand, process.platform, defaultSandboxConfig())).find(
    (s) => s.kind === 'bwrap',
  )?.available === true;

test.skipIf(!bwrapOk)(
  'bwrap end to end: writes confined, secrets and home hidden, network off',
  async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mia-sbx-')));
    await fs.writeFile(path.join(root, '.env'), 'TOPSECRET=1');
    const choice = await chooseSandbox(runCommand, process.platform, defaultSandboxConfig(), root, [
      '.env',
    ]);
    expect(choice.sandbox).toBeTruthy();
    const run = async (cmd: string) => {
      const w = choice.sandbox!.wrap(['/bin/sh', '-c', cmd]);
      return runCommand(w.command, w.args, { timeoutMs: 20_000 });
    };
    expect((await run('echo a > ok.txt')).exitCode).toBe(0);
    expect(await fs.readFile(path.join(root, 'ok.txt'), 'utf8')).toBe('a\n');
    expect((await run('echo a > /etc/mia-test')).exitCode).not.toBe(0);
    expect((await run('cat .env')).stdout.includes('TOPSECRET')).toBe(false);
    expect((await run('ls "$HOME" | wc -l')).stdout.trim()).toBe('0');
    const net = await run('cat /proc/net/dev | tail -n +3 | grep -v "lo:" | wc -l');
    expect(net.stdout.trim()).toBe('0');
    await fs.rm(root, { recursive: true, force: true });
  },
);
