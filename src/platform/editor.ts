import { spawn } from 'node:child_process';

export interface EditorCommand {
  command: string;
  args: string[];
}

/** Picks $VISUAL, then $EDITOR, then a platform default (notepad on Windows, vi elsewhere). */
export function editorCommand(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): EditorCommand {
  const raw = (env['VISUAL'] ?? '').trim() || (env['EDITOR'] ?? '').trim();
  if (raw !== '') {
    const [command = raw, ...args] = raw.split(/\s+/);
    return { command, args };
  }
  return { command: platform === 'win32' ? 'notepad' : 'vi', args: [] };
}

export interface EditResult {
  exitCode: number;
  /** Set when the editor could not be started. */
  error?: string;
}

/** Opens a file in the user's editor with the terminal attached. */
export function editFile(
  file: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<EditResult> {
  const { command, args } = editorCommand(env, platform);
  return new Promise((resolve) => {
    // On Windows, editors such as VS Code are .cmd shims that need a shell to launch.
    const useShell = platform === 'win32';
    const child = spawn(command, [...args, useShell ? `"${file}"` : file], {
      stdio: 'inherit',
      shell: useShell,
      env,
    });
    child.on('error', (error) => resolve({ exitCode: 127, error: error.message }));
    child.on('exit', (code) => resolve({ exitCode: code ?? 1 }));
  });
}
