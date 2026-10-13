import { spawn } from 'node:child_process';

export interface RunOptions {
  /** Written to the child's stdin, then stdin is closed. Use this (not argv) for secrets. */
  input?: string;
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface RunResult {
  /** null when the process could not be started, was killed, or timed out. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  /** Set when spawning failed (for example ENOENT when the program is not installed). */
  error?: Error;
}

export type Runner = (
  command: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<RunResult>;

/**
 * Runs an executable with an explicit argument list. Never uses a shell, so
 * arguments are not subject to shell parsing or injection.
 */
export const runCommand: Runner = (command, args, options = {}) =>
  new Promise<RunResult>((resolve) => {
    const maxBytes = options.maxOutputBytes ?? 2_000_000;
    let stdout = '';
    let stderr = '';
    let size = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const onAbort = (): void => {
      child.kill();
    };

    const finish = (exitCode: number | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const result: RunResult = { exitCode, stdout, stderr, timedOut, truncated };
      if (error) result.error = error;
      resolve(result);
    };

    const collect = (target: 'out' | 'err') => (chunk: string) => {
      if (size >= maxBytes) {
        truncated = true;
        return;
      }
      size += chunk.length;
      if (target === 'out') stdout += chunk;
      else stderr += chunk;
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));
    child.stdin.on('error', () => undefined);
    child.on('error', (err) => finish(null, err));
    child.on('close', (code) => finish(code));

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, options.timeoutMs);
    }
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    if (options.input !== undefined) child.stdin.write(options.input);
    child.stdin.end();
  });
