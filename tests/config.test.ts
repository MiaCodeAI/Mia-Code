import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, defaultConfig, validateConfig } from '../src/config/schema.js';
import { ConfigStore } from '../src/config/store.js';
import { makeHarness, type TestHarness } from './helpers/fakes.js';

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const valid = {
  version: 1,
  defaultProvider: 'openai',
  providers: {
    openai: { kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1/', model: 'm' },
  },
};

describe('validateConfig', () => {
  it('accepts a valid config and normalizes URLs', () => {
    const { config, errors } = validateConfig(valid);
    expect(errors).toEqual([]);
    expect(config.providers['openai']?.baseUrl).toBe('https://api.openai.com/v1');
    expect(config.defaultProvider).toBe('openai');
    expect(config.limits.maxRetries).toBe(2);
  });

  it('reports every problem, not just the first', () => {
    const { errors } = validateConfig({
      version: 2,
      providers: {
        'Bad Name': { kind: 'nope', baseUrl: 'http://x.com' },
        ok: { kind: 'anthropic', baseUrl: 'ftp://x' },
      },
      limits: { maxRetries: 99 },
      extra: true,
    });
    expect(errors.length).toBeGreaterThanOrEqual(5);
    expect(errors.join('\n')).toMatch(/unknown setting "extra"/);
    expect(errors.join('\n')).toMatch(/maxRetries/);
  });

  it('rejects a default provider that does not exist', () => {
    const { errors } = validateConfig({ version: 1, defaultProvider: 'ghost', providers: {} });
    expect(errors.join()).toMatch(/not a configured provider/);
  });

  it('requires apiKeyEnv to be a variable name, not a key', () => {
    const { errors } = validateConfig({
      version: 1,
      providers: {
        a: {
          kind: 'openai-compatible',
          baseUrl: 'https://x.com',
          apiKeyEnv: 'sk-abcdefghijklmnopqrstuvwx',
        },
      },
    });
    expect(errors.join()).toMatch(/environment variable NAME/);
  });

  it('requires a date on pricing so prices are never undated', () => {
    const { errors } = validateConfig({
      version: 1,
      pricing: { 'a/m': { inputPerMTok: 1, outputPerMTok: 2 } },
    });
    expect(errors.join()).toMatch(/asOf/);
    const ok = validateConfig({
      version: 1,
      pricing: { 'a/m': { inputPerMTok: 1, outputPerMTok: 2, asOf: '2026-01-31' } },
    });
    expect(ok.errors).toEqual([]);
  });

  it('rejects non-objects', () => {
    expect(validateConfig([]).errors.length).toBe(1);
    expect(validateConfig('x').errors.length).toBe(1);
  });
});

describe('ConfigStore', () => {
  it('returns defaults when the file is missing', async () => {
    h = await makeHarness();
    expect(await h.ctx.config.load()).toEqual(defaultConfig());
  });

  it('round-trips through an atomic write and leaves no temp files', async () => {
    h = await makeHarness();
    await h.ctx.config.update((c) => {
      c.providers['a'] = { kind: 'anthropic', baseUrl: 'https://api.anthropic.com' };
      c.defaultProvider = 'a';
    });
    const loaded = await h.ctx.config.load();
    expect(loaded.defaultProvider).toBe('a');
    const files = await fs.readdir(path.dirname(h.ctx.config.file));
    expect(files).toEqual(['config.json']);
  });

  it('refuses to save anything that looks like an API key', async () => {
    h = await makeHarness();
    const config = defaultConfig();
    config.providers['a'] = {
      kind: 'openai-compatible',
      baseUrl: 'https://x.com',
      model: 'sk-abcdefghijklmnopqrstuvwxyz',
    };
    await expect(h.ctx.config.save(config)).rejects.toThrow(/API key/);
    await expect(fs.access(h.ctx.config.file)).rejects.toThrow();
  });

  it('refuses invalid configs and reports invalid files clearly', async () => {
    h = await makeHarness();
    const bad = defaultConfig();
    bad.defaultProvider = 'ghost';
    await expect(h.ctx.config.save(bad)).rejects.toBeInstanceOf(ConfigError);

    await fs.mkdir(path.dirname(h.ctx.config.file), { recursive: true });
    await fs.writeFile(h.ctx.config.file, '{ not json');
    await expect(new ConfigStore(h.ctx.config.file).load()).rejects.toThrow(/not valid JSON/);
  });

  it.runIf(process.platform !== 'win32')('writes the file readable only by the owner', async () => {
    h = await makeHarness();
    await h.ctx.config.save(defaultConfig());
    const mode = (await fs.stat(h.ctx.config.file)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
