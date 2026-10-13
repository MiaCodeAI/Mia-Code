import os from 'node:os';
import { ConfigStore } from './config/store.js';
import { createCredentialStore } from './credentials/resolve.js';
import type { CredentialStore } from './credentials/types.js';
import { editFile, type EditResult } from './platform/editor.js';
import { configFile, defaultPathContext, type PathContext } from './platform/paths.js';
import { runCommand, type Runner } from './platform/exec.js';
import { defaultSleep, type RetryPolicy } from './providers/retry.js';
import { redact } from './security/redact.js';
import { createStyler, shouldUseColor, type Styler } from './ui/ansi.js';
import { StdioTerminal, type Terminal } from './ui/terminal.js';
import { getVersion } from './version.js';

/** Everything a command needs from its environment. Tests substitute fakes for any field. */
export interface Context {
  version: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  arch: string;
  pathContext: PathContext;
  stdoutIsTTY: boolean;
  columns: number;
  style: Styler;
  config: ConfigStore;
  credentials: CredentialStore;
  run: Runner;
  fetchImpl: typeof fetch;
  sleep: RetryPolicy['sleep'];
  /** Writes a line to stdout. All output passes through secret redaction. */
  print(line?: string): void;
  /** Writes a line to stderr. */
  printErr(line: string): void;
  /** Writes text to stdout without a trailing newline (streamed model output). */
  write(text: string): void;
  terminal(): Terminal;
  closeTerminal(): void;
  /** Opens a file in the user's editor and waits for it to close. */
  editFile(file: string): Promise<EditResult>;
}

export function createDefaultContext(): Context {
  const pathContext = defaultPathContext();
  const stdoutIsTTY = Boolean(process.stdout.isTTY);
  let terminal: Terminal | undefined;
  return {
    version: getVersion(),
    cwd: process.cwd(),
    env: process.env,
    platform: process.platform,
    arch: os.arch(),
    pathContext,
    stdoutIsTTY,
    columns: process.stdout.columns ?? 80,
    style: createStyler(shouldUseColor(process.env, stdoutIsTTY)),
    config: new ConfigStore(configFile(pathContext)),
    credentials: createCredentialStore(pathContext),
    run: runCommand,
    fetchImpl: fetch,
    sleep: defaultSleep,
    print: (line = '') => {
      process.stdout.write(`${redact(line)}\n`);
    },
    printErr: (line) => {
      process.stderr.write(`${redact(line)}\n`);
    },
    write: (text) => {
      process.stdout.write(redact(text));
    },
    terminal: () => (terminal ??= new StdioTerminal()),
    closeTerminal: () => {
      terminal?.close();
      terminal = undefined;
    },
    editFile: (file) => editFile(file, process.env, process.platform),
  };
}
