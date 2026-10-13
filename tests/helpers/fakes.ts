import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../../src/config/store.js';
import type { Context } from '../../src/context.js';
import { MemoryCredentialStore } from '../../src/credentials/types.js';
import type { RunResult, Runner } from '../../src/platform/exec.js';
import { createStyler } from '../../src/ui/ansi.js';
import type { Terminal } from '../../src/ui/terminal.js';

export class FakeTerminal implements Terminal {
  readonly secretsRead: string[] = [];
  constructor(
    private readonly lines: string[] = [],
    readonly interactive = true,
  ) {}
  async readLine(): Promise<string | null> {
    return this.lines.shift() ?? null;
  }
  async readSecret(): Promise<string | null> {
    const line = this.lines.shift() ?? null;
    if (line !== null) this.secretsRead.push(line);
    return line;
  }
  onInterrupt(): void {}
  close(): void {}
}

export interface TestHarness {
  ctx: Context;
  out: string[];
  err: string[];
  dir: string;
  credentials: MemoryCredentialStore;
  cleanup(): Promise<void>;
}

export function okRun(stdout = ''): RunResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false, truncated: false };
}

export async function makeHarness(
  options: {
    input?: string[];
    interactive?: boolean;
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    run?: Runner;
    cwd?: string;
  } = {},
): Promise<TestHarness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mia-test-'));
  const out: string[] = [];
  const err: string[] = [];
  const credentials = new MemoryCredentialStore();
  const terminal = new FakeTerminal(options.input ?? [], options.interactive ?? true);
  const env = options.env ?? {};
  const ctx: Context = {
    version: '0.0.0-test',
    cwd: options.cwd ?? dir,
    env,
    platform: 'linux',
    arch: 'x64',
    pathContext: { platform: 'linux', env, homedir: dir },
    stdoutIsTTY: false,
    columns: 80,
    style: createStyler(false),
    config: new ConfigStore(path.join(dir, 'config', 'config.json')),
    credentials,
    run:
      options.run ??
      (async () => ({ exitCode: 1, stdout: '', stderr: '', timedOut: false, truncated: false })),
    fetchImpl: options.fetchImpl ?? (async () => new Response('{}', { status: 500 })),
    sleep: async () => undefined,
    print: (line = '') => {
      out.push(line);
    },
    printErr: (line) => {
      err.push(line);
    },
    write: (text) => {
      out.push(text);
    },
    terminal: () => terminal,
    closeTerminal: () => undefined,
    editFile: async () => ({ exitCode: 0 }),
  };
  return {
    ctx,
    out,
    err,
    dir,
    credentials,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

/** Builds a streaming Response from raw SSE text, optionally split into small chunks. */
export function sseResponse(text: string, chunkSize = 17, status = 200): Response {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize)
        controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake fetch that records requests and answers from a queue of handlers. */
export function fakeFetch(handlers: ((call: RecordedCall) => Response | Promise<Response>)[]): {
  fetch: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const queue = [...handlers];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: RecordedCall = { url: String(input), method: init?.method ?? 'GET', headers, body };
    calls.push(call);
    const handler = queue.shift();
    if (!handler) throw new Error(`unexpected request to ${call.url}`);
    return handler(call);
  };
  return { fetch: impl as typeof fetch, calls };
}
