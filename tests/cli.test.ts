import fs from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import {
  fakeFetch,
  jsonResponse,
  makeHarness,
  sseResponse,
  type TestHarness,
} from './helpers/fakes.js';

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const KEY = 'sk-test-abcdefghijklmnopqrstuvwx';
const stream =
  'data: {"choices":[{"delta":{"content":"This is a demo"}}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":40,"completion_tokens":6}}\n\n' +
  'data: [DONE]\n\n';

const everything = (x: TestHarness) => [...x.out, ...x.err].join('\n');

async function addOpenAI(x: TestHarness, model?: string): Promise<void> {
  expect(
    await run(
      ['provider', 'add', '--preset', 'openai', '--use', ...(model ? ['--model', model] : [])],
      x.ctx,
    ),
  ).toBe(0);
}

describe('basic commands', () => {
  it('prints the version and help', async () => {
    h = await makeHarness();
    expect(await run(['--version'], h.ctx)).toBe(0);
    expect(h.out).toEqual(['0.0.0-test']);
    expect(await run(['help'], h.ctx)).toBe(0);
    expect(everything(h)).toContain('mia init');
    for (const topic of ['init', 'ask', 'doctor', 'auth', 'provider', 'model', 'config']) {
      h.out.length = 0;
      expect(await run(['help', topic], h.ctx)).toBe(0);
      expect(h.out.join('')).toContain(
        `mia ${topic === 'init' || topic === 'ask' || topic === 'doctor' ? topic : topic}`,
      );
    }
  });

  it('suggests corrections for unknown commands with exit code 2', async () => {
    h = await makeHarness();
    expect(await run(['dotcor'], h.ctx)).toBe(2);
    expect(h.err.join()).toContain('Did you mean "mia doctor"');
    h.err.length = 0;
    expect(await run(['provider', 'ad'], h.ctx)).toBe(2);
    expect(h.err.join()).toContain('provider add');
  });

  it('rejects unknown flags instead of ignoring them', async () => {
    h = await makeHarness();
    expect(await run(['doctor', '--bogus'], h.ctx)).toBe(2);
  });
});

describe('provider management', () => {
  it('adds a preset, lists it, switches default and removes it', async () => {
    h = await makeHarness();
    await addOpenAI(h);
    expect(await run(['provider', 'add', '--preset', 'groq'], h.ctx)).toBe(0);
    expect(await run(['provider', 'use', 'groq'], h.ctx)).toBe(0);
    expect((await h.ctx.config.load()).defaultProvider).toBe('groq');
    h.out.length = 0;
    expect(await run(['provider', 'list'], h.ctx)).toBe(0);
    expect(h.out.join('\n')).toContain('openai');
    expect(await run(['provider', 'remove', 'groq', '--yes'], h.ctx)).toBe(0);
    expect((await h.ctx.config.load()).defaultProvider).toBeUndefined();
  });

  it('adds a custom endpoint but refuses insecure URLs and duplicate names', async () => {
    h = await makeHarness();
    expect(
      await run(
        [
          'provider',
          'add',
          '--name',
          'mine',
          '--kind',
          'openai-compatible',
          '--base-url',
          'https://llm.example.com/v1',
        ],
        h.ctx,
      ),
    ).toBe(0);
    expect(
      await run(
        [
          'provider',
          'add',
          '--name',
          'bad',
          '--kind',
          'openai-compatible',
          '--base-url',
          'http://llm.example.com/v1',
        ],
        h.ctx,
      ),
    ).toBe(1);
    expect(h.err.join()).toMatch(/https/);
    expect(
      await run(
        [
          'provider',
          'add',
          '--name',
          'mine',
          '--kind',
          'openai-compatible',
          '--base-url',
          'https://llm.example.com/v1',
        ],
        h.ctx,
      ),
    ).toBe(1);
    expect(h.err.join()).toMatch(/--force/);
  });

  it('requires confirmation to remove non-interactively', async () => {
    h = await makeHarness({ interactive: false });
    await addOpenAI(h);
    expect(await run(['provider', 'remove', 'openai'], h.ctx)).toBe(2);
  });
});

describe('auth login', () => {
  it('validates the key with the provider, stores it securely and never prints it', async () => {
    const f = fakeFetch([() => jsonResponse({ data: [{ id: 'gpt-a' }, { id: 'gpt-b' }] })]);
    h = await makeHarness({ input: [KEY], fetchImpl: f.fetch });
    await addOpenAI(h);
    expect(await run(['auth', 'login', 'openai'], h.ctx)).toBe(0);

    expect(await h.credentials.get('openai')).toBe(KEY);
    expect(f.calls[0]!.url).toBe('https://api.openai.com/v1/models');
    expect(f.calls[0]!.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(everything(h)).not.toContain(KEY);
    expect(await fs.readFile(h.ctx.config.file, 'utf8')).not.toContain(KEY);

    h.out.length = 0;
    expect(await run(['auth', 'list'], h.ctx)).toBe(0);
    expect(h.out.join('\n')).toContain('1 found: default (store:memory)');
    expect(everything(h)).not.toContain(KEY);
  });

  it('does not store a key the provider rejects, and explains why', async () => {
    const f = fakeFetch([
      () => jsonResponse({ error: { message: `Incorrect API key ${KEY}` } }, 401),
    ]);
    h = await makeHarness({ input: [KEY], fetchImpl: f.fetch });
    await addOpenAI(h);
    expect(await run(['auth', 'login', 'openai'], h.ctx)).toBe(1);
    expect(await h.credentials.get('openai')).toBeNull();
    expect(h.err.join()).toMatch(/Authentication failed/);
    expect(h.err.join()).toMatch(/not stored/);
    expect(everything(h)).not.toContain(KEY);
  });

  it('does not store a key when the provider cannot be reached', async () => {
    const f = fakeFetch([
      () => {
        throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
      },
      () => {
        throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
      },
    ]);
    h = await makeHarness({ input: [KEY], fetchImpl: f.fetch });
    await addOpenAI(h);
    expect(await run(['auth', 'login', 'openai'], h.ctx)).toBe(1);
    expect(await h.credentials.get('openai')).toBeNull();
    expect(h.err.join()).toMatch(/--no-validate/);
  });

  it('refuses to read a key from a non-terminal unless --stdin is explicit', async () => {
    h = await makeHarness({ interactive: false, input: [KEY] });
    await addOpenAI(h);
    expect(await run(['auth', 'login', 'openai'], h.ctx)).toBe(1);
    expect(h.err.join()).toMatch(/--stdin/);
    expect(await h.credentials.get('openai')).toBeNull();
  });

  it('supports --stdin with --no-validate', async () => {
    h = await makeHarness({ interactive: false, input: [KEY] });
    await addOpenAI(h);
    expect(await run(['auth', 'login', 'openai', '--stdin', '--no-validate'], h.ctx)).toBe(0);
    expect(await h.credentials.get('openai')).toBe(KEY);
  });

  it('rejects keys that are obviously malformed', async () => {
    h = await makeHarness({ input: ['short'] });
    await addOpenAI(h);
    expect(await run(['auth', 'login', 'openai'], h.ctx)).toBe(1);
    expect(h.err.join()).toMatch(/too short/);
  });

  it('falls back to environment-variable instructions when secure storage is unavailable', async () => {
    const f = fakeFetch([() => jsonResponse({ data: [] })]);
    h = await makeHarness({ input: [KEY], fetchImpl: f.fetch });
    h.ctx.credentials = {
      name: 'none',
      isAvailable: async () => ({ available: false, reason: 'no keyring' }),
      get: async () => null,
      set: async () => {
        throw new Error('x');
      },
      delete: async () => false,
    };
    await addOpenAI(h);
    expect(await run(['auth', 'login', 'openai'], h.ctx)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toMatch(/NOT saved/);
    expect(text).toContain('OPENAI_API_KEY');
    expect(everything(h)).not.toContain(KEY);
  });

  it('removes stored keys after confirmation', async () => {
    h = await makeHarness();
    await addOpenAI(h);
    await h.credentials.set('openai', KEY);
    expect(await run(['auth', 'remove', 'openai', '--yes'], h.ctx)).toBe(0);
    expect(await h.credentials.get('openai')).toBeNull();
  });
});

describe('model commands', () => {
  it('lists models and selects one', async () => {
    const f = fakeFetch([() => jsonResponse({ data: [{ id: 'alpha' }, { id: 'beta' }] })]);
    h = await makeHarness({ env: { OPENAI_API_KEY: KEY }, fetchImpl: f.fetch });
    await addOpenAI(h);
    expect(await run(['model', 'list', '--filter', 'alp'], h.ctx)).toBe(0);
    expect(h.out.join('\n')).toContain('alpha');
    expect(h.out.join('\n')).not.toContain('beta');
    expect(await run(['model', 'use', 'beta'], h.ctx)).toBe(0);
    expect((await h.ctx.config.load()).providers['openai']?.model).toBe('beta');
    expect(h.out.join('\n')).toContain('unknown');
  });

  it('explains how to fix a missing key', async () => {
    h = await makeHarness();
    await addOpenAI(h);
    expect(await run(['model', 'list'], h.ctx)).toBe(1);
    expect(h.err.join()).toMatch(/mia auth login openai/);
  });
});

describe('provider test', () => {
  it('runs auth, model and streaming checks', async () => {
    const f = fakeFetch([() => jsonResponse({ data: [{ id: 'm1' }] }), () => sseResponse(stream)]);
    h = await makeHarness({ env: { OPENAI_API_KEY: KEY }, fetchImpl: f.fetch });
    await addOpenAI(h, 'm1');
    expect(await run(['provider', 'test'], h.ctx)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toMatch(/\[ok\] Authentication/);
    expect(text).toMatch(/\[ok\] Streaming request/);
    expect(everything(h)).not.toContain(KEY);
  });

  it('fails with a clear message on bad credentials', async () => {
    const f = fakeFetch([() => jsonResponse({ error: { message: 'nope' } }, 401)]);
    h = await makeHarness({ env: { OPENAI_API_KEY: KEY }, fetchImpl: f.fetch });
    await addOpenAI(h, 'm1');
    expect(await run(['provider', 'test'], h.ctx)).toBe(1);
    expect(h.out.join('\n')).toMatch(/\[FAIL\] Authentication/);
  });
});

describe('ask', () => {
  it('streams an answer to stdout and keeps notices on stderr', async () => {
    const f = fakeFetch([() => sseResponse(stream)]);
    h = await makeHarness({ env: { OPENAI_API_KEY: KEY }, fetchImpl: f.fetch });
    await fs.writeFile(`${h.dir}/package.json`, '{}');
    await addOpenAI(h, 'm1');
    expect(await run(['ask', 'What', 'is', 'this?'], h.ctx)).toBe(0);

    expect(h.out.join('')).toContain('This is a demo');
    expect(h.err.join('\n')).toMatch(/Sending your question/);
    expect(h.err.join('\n')).toMatch(/tokens in 40/);
    const body = f.calls[0]!.body as { messages: { role: string; content: string }[] };
    expect(body.messages[0]!.content).toContain('package.json');
    expect(body.messages[1]).toEqual({ role: 'user', content: 'What is this?' });
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it('does not send the project overview with --no-context', async () => {
    const f = fakeFetch([() => sseResponse(stream)]);
    h = await makeHarness({ env: { OPENAI_API_KEY: KEY }, fetchImpl: f.fetch });
    await addOpenAI(h, 'm1');
    expect(await run(['ask', '--no-context', 'hi'], h.ctx)).toBe(0);
    const body = f.calls[0]!.body as { messages: { content: string }[] };
    expect(body.messages[0]!.content).toContain('No project overview');
  });

  it('shows exactly what would be sent without contacting any provider', async () => {
    h = await makeHarness();
    await fs.writeFile(`${h.dir}/.env`, 'SECRET=1');
    await fs.writeFile(`${h.dir}/main.py`, 'x');
    expect(await run(['ask', '--show-context'], h.ctx)).toBe(0);
    expect(h.out.join('\n')).toContain('main.py');
    expect(h.out.join('\n')).not.toContain('.env');
  });

  it('reports provider failures as clean errors', async () => {
    const f = fakeFetch([() => jsonResponse({ error: { message: 'bad' } }, 401)]);
    h = await makeHarness({ env: { OPENAI_API_KEY: KEY }, fetchImpl: f.fetch });
    await addOpenAI(h, 'm1');
    expect(await run(['ask', 'hi'], h.ctx)).toBe(1);
    expect(h.err.join()).toMatch(/Authentication failed/);
  });

  it('asks for a model before spending anything', async () => {
    const f = fakeFetch([]);
    h = await makeHarness({ env: { OPENAI_API_KEY: KEY }, fetchImpl: f.fetch });
    await addOpenAI(h);
    expect(await run(['ask', 'hi'], h.ctx)).toBe(1);
    expect(h.err.join()).toMatch(/No model selected/);
    expect(f.calls).toHaveLength(0);
  });
});

describe('interactive session', () => {
  it('answers questions, supports slash commands and ends cleanly', async () => {
    const f = fakeFetch([() => sseResponse(stream)]);
    h = await makeHarness({
      env: { OPENAI_API_KEY: KEY },
      fetchImpl: f.fetch,
      input: ['/help', 'what is this project?', '/usage', '/bogus', '/quit'],
    });
    await addOpenAI(h, 'm1');
    expect(await run([], h.ctx)).toBe(0);
    const text = everything(h);
    expect(text).toContain('Mia Code v0.0.0-test');
    expect(text).toContain('█');
    expect(text).toMatch(/mode\s+ask:/);
    expect(text).toContain('This is a demo');
    expect(text).toContain('requests 1');
    expect(text).toMatch(/Unknown command \/bogus/);
    expect(text).toContain('/context');
    expect(text).not.toContain(KEY);
  });

  it('points a new user to setup', async () => {
    h = await makeHarness();
    expect(await run([], h.ctx)).toBe(1);
    expect(h.out.join('\n')).toContain('mia init');
  });

  it('survives a provider error and keeps going', async () => {
    const f = fakeFetch([
      () => jsonResponse({ error: { message: 'bad' } }, 400),
      () => sseResponse(stream),
    ]);
    h = await makeHarness({
      env: { OPENAI_API_KEY: KEY },
      fetchImpl: f.fetch,
      input: ['first', 'second', '/quit'],
    });
    await addOpenAI(h, 'm1');
    expect(await run([], h.ctx)).toBe(0);
    const text = everything(h);
    expect(text).toMatch(/rejected the request/);
    expect(text).toContain('This is a demo');
  });
});

describe('init wizard', () => {
  it('walks through provider, key, model and test', async () => {
    const f = fakeFetch([
      () => jsonResponse({ data: [{ id: 'm1' }, { id: 'm2' }] }),
      () => jsonResponse({ data: [{ id: 'm1' }, { id: 'm2' }] }),
      () => sseResponse(stream),
    ]);
    // choices: provider 1 (openai), name (default), key, model 2, run test (y)
    h = await makeHarness({ input: ['1', '', KEY, '2', 'y'], fetchImpl: f.fetch });
    expect(await run(['init'], h.ctx)).toBe(0);
    const cfg = await h.ctx.config.load();
    expect(cfg.defaultProvider).toBe('openai');
    expect(cfg.providers['openai']?.model).toBe('m2');
    expect(await h.credentials.get('openai')).toBe(KEY);
    expect(everything(h)).not.toContain(KEY);
    expect(h.out.join('\n')).toContain('bring-your-own-key');
    expect(h.out.join('\n')).toContain('https://platform.openai.com/docs');
  });

  it('refuses to run without a terminal and explains the scripted alternative', async () => {
    h = await makeHarness({ interactive: false });
    expect(await run(['init'], h.ctx)).toBe(1);
    expect(h.err.join()).toContain('mia provider add');
  });
});

describe('doctor and config', () => {
  it('reports setup state without printing keys', async () => {
    const f = fakeFetch([() => jsonResponse({ data: [{ id: 'm1' }] })]);
    h = await makeHarness({ env: { OPENAI_API_KEY: KEY }, fetchImpl: f.fetch });
    await addOpenAI(h, 'm1');
    expect(await run(['doctor', '--online'], h.ctx)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('Node.js');
    expect(text).toContain('authenticated');
    expect(everything(h)).not.toContain(KEY);
  });

  it('emits JSON and exits 1 on a broken config', async () => {
    h = await makeHarness();
    await fs.mkdir(`${h.dir}/config`, { recursive: true });
    await fs.writeFile(h.ctx.config.file, '{ broken');
    expect(await run(['doctor', '--json'], h.ctx)).toBe(1);
    const parsed = JSON.parse(h.out.join('\n')) as {
      ok: boolean;
      checks: { name: string; status: string }[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.checks.find((c) => c.name === 'Config file')?.status).toBe('fail');
  });

  it('shows and locates the config, and validates after editing', async () => {
    h = await makeHarness();
    expect(await run(['config', 'path'], h.ctx)).toBe(0);
    expect(h.out[0]).toBe(h.ctx.config.file);
    expect(await run(['config'], h.ctx)).toBe(0);
    expect(await run(['config', 'edit'], h.ctx)).toBe(0);
    h.ctx.editFile = async (file) => {
      await fs.writeFile(file, '{"version":1,"limits":{"maxRetries":42}}');
      return { exitCode: 0 };
    };
    expect(await run(['config', 'edit'], h.ctx)).toBe(1);
    expect(h.err.join()).toMatch(/maxRetries/);
  });
});
