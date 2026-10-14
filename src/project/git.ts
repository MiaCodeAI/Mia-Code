import type { Runner } from '../platform/exec.js';

export interface GitInfo {
  root: string;
  branch: string | undefined;
  /** Number of paths with uncommitted changes (modified, staged or untracked). */
  changedPaths: number;
}

/**
 * Git is run with safeguards because repositories are untrusted input:
 * `core.fsmonitor` is disabled (a malicious repo can use it to run commands during `git status`),
 * optional lock files are skipped, and prompts are disabled.
 */
export function safeGitArgs(args: readonly string[]): string[] {
  return ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', ...args];
}

export function safeGitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
}

export async function readGitInfo(
  run: Runner,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<GitInfo | null> {
  const opts = { cwd, env: safeGitEnv(env), timeoutMs: 8000 };
  const top = await run('git', safeGitArgs(['rev-parse', '--show-toplevel']), opts);
  if (top.exitCode !== 0 || top.stdout.trim() === '') return null;

  let branch: string | undefined;
  const head = await run('git', safeGitArgs(['symbolic-ref', '--short', '-q', 'HEAD']), opts);
  if (head.exitCode === 0 && head.stdout.trim() !== '') branch = head.stdout.trim();
  else {
    const sha = await run('git', safeGitArgs(['rev-parse', '--short', 'HEAD']), opts);
    if (sha.exitCode === 0 && sha.stdout.trim() !== '')
      branch = `(detached at ${sha.stdout.trim()})`;
  }

  const status = await run('git', safeGitArgs(['status', '--porcelain']), {
    ...opts,
    maxOutputBytes: 1_000_000,
  });
  const changedPaths =
    status.exitCode === 0 ? status.stdout.split('\n').filter((l) => l.trim() !== '').length : 0;

  return { root: top.stdout.trim(), branch, changedPaths };
}

/** Lists only the files git tracks (committed or staged), relative to `cwd`. */
export async function listTrackedFiles(
  run: Runner,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string[] | null> {
  const result = await run('git', safeGitArgs(['ls-files', '-z', '--cached']), {
    cwd,
    env: safeGitEnv(env),
    timeoutMs: 15_000,
    maxOutputBytes: 8_000_000,
  });
  if (result.exitCode !== 0) return null;
  return result.stdout.split('\0').filter((p) => p !== '');
}

/** Lists tracked and untracked-but-not-ignored files, relative to `cwd`, honouring .gitignore. */
export async function listGitFiles(
  run: Runner,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string[] | null> {
  const result = await run(
    'git',
    safeGitArgs(['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
    {
      cwd,
      env: safeGitEnv(env),
      timeoutMs: 15_000,
      maxOutputBytes: 8_000_000,
    },
  );
  if (result.exitCode !== 0) return null;
  return result.stdout.split('\0').filter((p) => p !== '');
}
