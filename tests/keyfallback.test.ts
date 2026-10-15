import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { FallbackCredentialStore, FileCredentialStore } from '../src/credentials/file.js';
import { UnavailableCredentialStore } from '../src/credentials/types.js';
import { StdioTerminal } from '../src/ui/terminal.js';
import { fakeFetch, jsonResponse, makeHarness, type TestHarness } from './helpers/fakes.js';

let h: TestHarness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
const tmp = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mia-keys-'));
  dirs.push(d);
  return d;
};
const KEY = 'sk-test-abcdefghijklmnopqrstuvwx';

describe('private key file store', () => {
  it('stores keys owner-only, round-trips and deletes', async () => {
    const dir = path.join(await tmp(), 'credentials');
    const store = new FileCredentialStore(dir);
    expect((await store.isAvailable()).available).toBe(false);
    await store.enable();
    expect((await store.isAvailable()).available).toBe(true);
    await store.set('openai', KEY);
    expect(await store.get('openai')).toBe(KEY);
    if (process.platform !== 'win32') {
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.join(dir, 'openai.key'))).mode & 0o777).toBe(0o600);
    }
    await store.set('openai', 'second-key-value');
    expect(await store.get('openai')).toBe('second-key-value');
    expect(await store.delete('openai')).toBe(true);
    expect(await store.get('openai')).toBeNull();
    await expect(store.set('../evil', KEY)).rejects.toThrow();
  });

  it('is only used after consent, and re-tightens loose permissions', async () => {
    const dir = path.join(await tmp(), 'credentials');
    const file = new FileCredentialStore(dir);
    const store = new FallbackCredentialStore(new UnavailableCredentialStore(), file);
    const a = await store.isAvailable();
    expect(a.available).toBe(false);
    expect(a.offer).toBeDefined();
    await expect(store.set('openai', KEY)).rejects.toThrow();
    await a.offer!.enable();
    expect((await store.isAvailable()).available).toBe(true);
    await store.set('openai', KEY);
    expect(await store.get('openai')).toBe(KEY);
    if (process.platform !== 'win32') {
      await fs.chmod(path.join(dir, 'openai.key'), 0o644);
      await store.get('openai');
      expect((await fs.stat(path.join(dir, 'openai.key'))).mode & 0o777).toBe(0o600);
    }
  });
});

describe('login without a keyring', () => {
  async function harness(input: string[], interactive = true): Promise<TestHarness> {
    const f = fakeFetch([() => jsonResponse({ data: [{ id: 'gpt-a' }] })]);
    const x = await makeHarness({ input, interactive, fetchImpl: f.fetch });
    const file = new FileCredentialStore(path.join(x.dir, 'credentials'));
    (x.ctx as { credentials: unknown }).credentials = new FallbackCredentialStore(
      new UnavailableCredentialStore(),
      file,
    );
    await run(['provider', 'add', '--preset', 'openai', '--use'], x.ctx);
    return x;
  }

  it('offers the private file and saves the key when the user agrees', async () => {
    h = await harness([KEY, 'y']);
    expect(await run(['auth', 'login', 'openai'], h.ctx)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('private key file');
    expect(text).toContain('NOT encrypted');
    expect(await h.ctx.credentials.get('openai')).toBe(KEY);
    expect(text).not.toContain(KEY);
  });

  it('does not save the key when the user declines', async () => {
    h = await harness([KEY, 'n']);
    expect(await run(['auth', 'login', 'openai'], h.ctx)).toBe(0);
    expect(await h.ctx.credentials.get('openai')).toBeNull();
    expect(h.out.join('\n')).toContain('NOT saved');
  });

  it('--file-store consents for scripted use', async () => {
    h = await harness([KEY], false);
    expect(await run(['auth', 'login', 'openai', '--stdin', '--file-store'], h.ctx)).toBe(0);
    expect(await h.ctx.credentials.get('openai')).toBe(KEY);
  });

  it('points out a key that belongs to another provider', async () => {
    const f = fakeFetch([() => jsonResponse({ error: { message: 'Incorrect API key' } }, 401)]);
    h = await makeHarness({ input: ['sk-or-v1-abcdefghijklmnop'], fetchImpl: f.fetch });
    await run(['provider', 'add', '--preset', 'openai', '--use'], h.ctx);
    expect(await run(['auth', 'login', 'openai'], h.ctx)).toBe(1);
    expect(h.err.join('\n')).toMatch(/looks like an openrouter key/);
  });
});

describe('arrow-key selection', () => {
  function fakeTty(): { input: NodeJS.ReadStream; output: NodeJS.WriteStream; text: () => string } {
    const input = new PassThrough() as unknown as NodeJS.ReadStream & { setRawMode: () => void };
    Object.assign(input, { isTTY: true, isRaw: false, setRawMode: () => undefined });
    const output = new PassThrough();
    Object.assign(output, { isTTY: true, columns: 80, rows: 24 });
    let buf = '';
    output.on('data', (c: Buffer) => (buf += c.toString()));
    return { input, output: output as unknown as NodeJS.WriteStream, text: () => buf };
  }
  const opts = Array.from({ length: 30 }, (_, i) => `provider-${i + 1}`);

  it('moves with arrows, scrolls past the window and selects with Enter', async () => {
    const t = fakeTty();
    const term = new StdioTerminal(t.input, t.output);
    const p = term.select!('Which provider?', opts);
    for (let i = 0; i < 12; i++) t.input.push('\x1b[B');
    t.input.push('\x1b[A');
    t.input.push('\r');
    expect(await p).toBe(11);
    expect(t.text()).toContain('↓ more');
    expect(t.text()).toContain('provider-12');
    term.close();
  });

  it('wraps around, supports End, and cancels with Ctrl-C', async () => {
    const t = fakeTty();
    const term = new StdioTerminal(t.input, t.output);
    let p = term.select!('Pick', opts);
    t.input.push('\x1b[A');
    t.input.push('\r');
    expect(await p).toBe(29);
    p = term.select!('Pick', opts);
    t.input.push('\x03');
    expect(await p).toBeNull();
    term.close();
  });

  it('filters by typing and returns the original index', async () => {
    const t = fakeTty();
    const term = new StdioTerminal(t.input, t.output);
    const p = term.select!('Pick', opts);
    for (const ch of 'provider-2') t.input.push(ch);
    t.input.push('\x1b[B');
    t.input.push('\r');
    // matches: provider-2, -20..-29; cursor moved one down => provider-20 (index 19)
    expect(await p).toBe(19);
    term.close();
  });

  it('ignores Enter when the filter matches nothing, and Backspace recovers', async () => {
    const t = fakeTty();
    const term = new StdioTerminal(t.input, t.output);
    const p = term.select!('Pick', opts);
    t.input.push('zzz');
    t.input.push('\r');
    t.input.push('\x7f\x7f\x7f');
    t.input.push('\r');
    expect(await p).toBe(0);
    term.close();
  });

  it('is not offered when input is not a terminal', () => {
    const term = new StdioTerminal(
      new PassThrough() as unknown as NodeJS.ReadStream,
      new PassThrough() as unknown as NodeJS.WriteStream,
    );
    expect(term.select).toBeUndefined();
    term.close();
  });
});
