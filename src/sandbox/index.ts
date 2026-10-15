import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Runner } from '../platform/exec.js';
import {
  HOME_TOOL_DIRS,
  wrapWith,
  type NetworkPolicy,
  type SandboxKind,
  type WrapOptions,
  type Wrapped,
} from './backends.js';

export type { NetworkPolicy, SandboxKind } from './backends.js';
export type SandboxSetting = 'auto' | 'off' | SandboxKind;
export const SANDBOX_SETTINGS: readonly SandboxSetting[] = [
  'auto',
  'off',
  'bwrap',
  'seatbelt',
  'docker',
];

export interface SandboxConfig {
  mode: SandboxSetting;
  network: NetworkPolicy;
  /** Docker image for the docker backend. */
  image?: string;
  /** Extra writable absolute paths. */
  writable: string[];
}

export function defaultSandboxConfig(): SandboxConfig {
  return { mode: 'auto', network: 'off', writable: [] };
}

export interface BackendStatus {
  kind: SandboxKind;
  available: boolean;
  reason?: string;
}

/** Probes each backend by actually running a trivial command inside it. */
export async function probeBackends(
  run: Runner,
  platform: NodeJS.Platform,
  config: SandboxConfig,
): Promise<BackendStatus[]> {
  const out: BackendStatus[] = [];
  if (platform === 'linux') {
    const r = await run(
      'bwrap',
      ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-all', '--die-with-parent', 'true'],
      { timeoutMs: 10_000 },
    );
    out.push(
      r.exitCode === 0
        ? { kind: 'bwrap', available: true }
        : {
            kind: 'bwrap',
            available: false,
            reason: r.error
              ? 'bubblewrap (bwrap) is not installed (try: apt install bubblewrap / dnf install bubblewrap)'
              : `bubblewrap cannot create namespaces here: ${r.stderr.trim().split('\n')[0] ?? 'unknown error'}`,
          },
    );
  } else {
    out.push({ kind: 'bwrap', available: false, reason: 'bubblewrap is Linux-only' });
  }
  if (platform === 'darwin') {
    const r = await run('sandbox-exec', ['-p', '(version 1)(allow default)', 'true'], {
      timeoutMs: 10_000,
    });
    out.push(
      r.exitCode === 0
        ? { kind: 'seatbelt', available: true }
        : { kind: 'seatbelt', available: false, reason: 'sandbox-exec is not usable' },
    );
  } else out.push({ kind: 'seatbelt', available: false, reason: 'Seatbelt is macOS-only' });
  const d = await run('docker', ['version', '--format', '{{.Server.Version}}'], {
    timeoutMs: 10_000,
  });
  if (d.exitCode !== 0)
    out.push({
      kind: 'docker',
      available: false,
      reason: d.error ? 'docker is not installed' : 'the docker daemon is not reachable',
    });
  else if (!config.image)
    out.push({
      kind: 'docker',
      available: false,
      reason: 'docker works, but no image is configured (sandbox.image / --sandbox-image)',
    });
  else out.push({ kind: 'docker', available: true });
  return out;
}

export interface ActiveSandbox {
  kind: SandboxKind;
  network: NetworkPolicy;
  writable: string[];
  image?: string;
  root: string;
  hide: string[];
  home: string;
  platform: NodeJS.Platform;
  homeToolDirs: string[];
  describe(): string;
  wrap(shell: readonly string[], overrides?: { network?: NetworkPolicy }): Wrapped;
}

export interface SandboxChoice {
  sandbox: ActiveSandbox | null;
  /** Why no sandbox is active (when none is). */
  reason?: string;
}

async function existingToolDirs(home: string): Promise<string[]> {
  const found: string[] = [];
  for (const rel of HOME_TOOL_DIRS) {
    const p = path.join(home, rel);
    try {
      if ((await fs.stat(p)).isDirectory()) found.push(p);
    } catch {
      /* not installed */
    }
  }
  return found;
}

/** Chooses the backend for a setting. `auto` picks the best available OS-level one. */
export async function chooseSandbox(
  run: Runner,
  platform: NodeJS.Platform,
  config: SandboxConfig,
  root: string,
  secretFiles: readonly string[],
): Promise<SandboxChoice> {
  if (config.mode === 'off') return { sandbox: null, reason: 'sandbox disabled (--sandbox off)' };
  const statuses = await probeBackends(run, platform, config);
  const order: SandboxKind[] =
    config.mode === 'auto' ? ['bwrap', 'seatbelt', 'docker'] : [config.mode];
  const pick = order.map((k) => statuses.find((s) => s.kind === k)).find((s) => s?.available);
  if (!pick) {
    const why = order
      .map((k) => `${k}: ${statuses.find((s) => s.kind === k)?.reason ?? 'unavailable'}`)
      .join('; ');
    return {
      sandbox: null,
      reason:
        platform === 'win32'
          ? `no OS sandbox on Windows (use WSL2 or Docker: --sandbox docker --sandbox-image <image>); ${why}`
          : why,
    };
  }
  const home = os.homedir();
  const hide = secretFiles.map((s) => path.join(root, ...s.split('/')));
  const base = {
    kind: pick.kind,
    network: config.network,
    writable: config.writable,
    ...(config.image ? { image: config.image } : {}),
    root,
    hide,
    home,
    platform,
    homeToolDirs: pick.kind === 'bwrap' ? await existingToolDirs(home) : [],
  };
  const sandbox: ActiveSandbox = {
    ...base,
    describe() {
      return `${this.kind}, network ${this.network}, writes limited to the project${this.writable.length ? ` + ${this.writable.length} extra path(s)` : ''}, $HOME hidden`;
    },
    wrap(shell, overrides) {
      const opts: WrapOptions = {
        root: this.root,
        network: overrides?.network ?? this.network,
        writable: this.writable,
        hide: this.hide,
        home: this.home,
        platform: this.platform,
        homeToolDirs: this.homeToolDirs,
        ...(this.image ? { image: this.image } : {}),
        ...(typeof process.getuid === 'function'
          ? { uid: process.getuid(), gid: process.getgid?.() ?? 0 }
          : {}),
      };
      return wrapWith(this.kind, shell, opts);
    },
  };
  return { sandbox };
}
