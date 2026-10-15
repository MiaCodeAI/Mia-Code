import os from 'node:os';
import path from 'node:path';

export type SandboxKind = 'bwrap' | 'seatbelt' | 'docker';
export type NetworkPolicy = 'off' | 'on';

export interface WrapOptions {
  /** Real path of the project; the only writable location besides temp and `writable`. */
  root: string;
  network: NetworkPolicy;
  /** Extra writable absolute paths the user granted. */
  writable: string[];
  /** Absolute paths of secret files inside the project that must be unreadable. */
  hide: string[];
  home: string;
  platform: NodeJS.Platform;
  /** Docker image (docker backend only). */
  image?: string;
  /** Existing paths below $HOME that tooling needs read-only (version managers and toolchains). */
  homeToolDirs: string[];
  uid?: number;
  gid?: number;
}

export interface Wrapped {
  command: string;
  args: string[];
}

/** Directories under $HOME that hold toolchains (not credentials). They are exposed read-only if present. */
export const HOME_TOOL_DIRS = [
  '.nvm',
  '.volta',
  '.fnm',
  '.asdf',
  '.pyenv',
  '.rbenv',
  '.sdkman',
  '.cargo',
  '.rustup',
  '.bun',
  '.deno',
  '.local/share/pnpm',
  '.local/share/fnm',
];

/** Locations that always hold credentials and are never exposed. */
export const CREDENTIAL_DIRS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gcloud',
  '.azure',
  '.kube',
  '.docker',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  '.config/gh',
];

const within = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * Linux: bubblewrap. The whole file system is visible read-only, $HOME is replaced by an empty
 * temporary directory (so SSH keys, cloud credentials and tokens are not reachable), only the
 * project (and explicit extras) is writable, /tmp is private, secret files in the project are
 * masked, processes/IPC are isolated, and the network is cut unless allowed.
 */
export function bwrapArgs(shell: readonly string[], o: WrapOptions): Wrapped {
  const a: string[] = [
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
  ];
  a.push('--tmpfs', o.home);
  for (const dir of o.homeToolDirs) a.push('--ro-bind', dir, dir);
  a.push('--bind', o.root, o.root);
  for (const w of o.writable) a.push('--bind', w, w);
  for (const secret of o.hide) a.push('--ro-bind', '/dev/null', secret);
  a.push(
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--die-with-parent',
    '--new-session',
    '--cap-drop',
    'ALL',
  );
  if (o.network === 'off') a.push('--unshare-net');
  a.push('--setenv', 'HOME', o.home, '--chdir', o.root, '--', ...shell);
  return { command: 'bwrap', args: a };
}

const sbString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * macOS: sandbox-exec (Seatbelt). Deny by default; allow process execution and reading, deny the
 * credential directories and project secret files, allow writes only to the project, temp and extras.
 * NOTE: sandbox-exec is deprecated by Apple but still shipped; this backend is unverified on a real Mac.
 */
export function seatbeltProfile(o: WrapOptions): string {
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-exec) (allow process-fork) (allow signal (target self)) (allow sysctl-read)',
    '(allow mach-lookup) (allow ipc-posix-shm) (allow file-read*)',
    ...CREDENTIAL_DIRS.map((d) => `(deny file-read* (subpath ${sbString(path.join(o.home, d))}))`),
    ...o.hide.map((f) => `(deny file-read* (literal ${sbString(f)}))`),
    `(allow file-write* (subpath ${sbString(o.root)}) (subpath ${sbString(os.tmpdir())}) (subpath "/private/tmp") (subpath "/private/var/folders") (literal "/dev/null") (literal "/dev/tty"))`,
    ...o.writable.map((w) => `(allow file-write* (subpath ${sbString(w)}))`),
    ...o.hide.map((f) => `(deny file-write* (literal ${sbString(f)}))`),
  ];
  if (o.network === 'on') lines.push('(allow network*)');
  return lines.join('\n');
}

export function seatbeltArgs(shell: readonly string[], o: WrapOptions): Wrapped {
  return { command: 'sandbox-exec', args: ['-p', seatbeltProfile(o), ...shell] };
}

/** Any OS: a Docker container with the project mounted. Needs an image that contains your toolchain. */
export function dockerArgs(shell: readonly string[], o: WrapOptions): Wrapped {
  if (!o.image)
    throw new Error('The docker sandbox needs an image (sandbox.image or --sandbox-image).');
  const a = [
    'run',
    '--rm',
    '-i',
    '--network',
    o.network === 'off' ? 'none' : 'bridge',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '1024',
    '-v',
    `${o.root}:/workspace:rw`,
    '-w',
    '/workspace',
  ];
  if (o.uid !== undefined && o.gid !== undefined) a.push('--user', `${o.uid}:${o.gid}`);
  for (const secret of o.hide) {
    const rel = path.relative(o.root, secret).split(path.sep).join('/');
    if (within(o.root, secret)) a.push('-v', `/dev/null:/workspace/${rel}:ro`);
  }
  for (const w of o.writable) a.push('-v', `${w}:${w}:rw`);
  a.push(o.image, ...shell);
  return { command: 'docker', args: a };
}

export function wrapWith(kind: SandboxKind, shell: readonly string[], o: WrapOptions): Wrapped {
  switch (kind) {
    case 'bwrap':
      return bwrapArgs(shell, o);
    case 'seatbelt':
      return seatbeltArgs(shell, o);
    case 'docker':
      return dockerArgs(shell, o);
  }
}
