import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toolByName, type ToolEnv } from '../src/agent/tools.js';
import { Checkpoints } from '../src/agent/checkpoints.js';
import { run } from '../src/cli.js';
import { RepoIndex } from '../src/repo/index.js';
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
const chat =
  'data: {"choices":[{"delta":{"content":"Done."}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

async function setup(input: string[], fetchImpl?: typeof fetch): Promise<TestHarness> {
  const x = await makeHarness({ input, fetchImpl, env: { OPENAI_API_KEY: KEY } });
  await fs.writeFile(
    path.join(x.dir, 'package.json'),
    '{"name":"demo","scripts":{"test":"vitest"}}',
  );
  await fs.writeFile(path.join(x.dir, 'index.js'), 'console.log(1)\n');
  await run(['provider', 'add', '--preset', 'openai', '--use', '--model', 'gpt-x'], x.ctx);
  return x;
}

describe('session: plain English runs Mia commands locally', () => {
  it('handles scan, mode, usage, models and status without calling the model', async () => {
    const f = fakeFetch([() => jsonResponse({ data: [{ id: 'gpt-x' }, { id: 'gpt-y' }] })]);
    h = await setup(
      [
        'scan project',
        'switch to read only mode',
        'what mode am I in?',
        'list models',
        'how many tokens have I used',
        'bye',
      ],
      f.fetch,
    );
    expect(await run([], h.ctx)).toBe(0);
    const out = h.out.join('\n');
    expect(out).toContain('→ /scan');
    expect(out).toContain('→ /mode readonly');
    expect(out).toMatch(/Mode: readonly|read[- ]?only/i);
    expect(out).toContain('gpt-y');
    expect(out).toContain('requests 0');
    // Only the model listing hit the network; nothing was sent to the chat endpoint.
    expect(f.calls.every((c) => c.url.endsWith('/models'))).toBe(true);
  });

  it('sends other requests to the model', async () => {
    const f = fakeFetch([() => sseResponse(chat)]);
    h = await setup(['fix the failing login test', '/quit'], f.fetch);
    expect(await run([], h.ctx)).toBe(0);
    expect(f.calls.length).toBe(1);
    expect(h.out.join('\n')).toContain('Done.');
  });

  it('tells the user setup needs its own terminal instead of taking keys in chat', async () => {
    h = await setup(['add an api key', '/quit']);
    expect(await run([], h.ctx)).toBe(0);
    expect(h.out.join('\n')).toContain('mia auth login');
  });
});

describe('shell: mia <plain English>', () => {
  it('maps requests onto commands', async () => {
    h = await setup([]);
    expect(await run(['please', 'scan', 'the', 'project'], h.ctx)).toBe(0);
    expect(h.out.join('\n')).toMatch(/demo|index\.js|Languages/i);
    expect(h.err.join('\n')).toContain('→ mia scan');
    h.out.length = 0;
    expect(await run(['audit', 'this', 'repo'], h.ctx)).toBe(0);
    expect(h.out.join('\n')).toContain('audit');
  });

  it('sends everything else to the agent', async () => {
    const f = fakeFetch([() => sseResponse(chat)]);
    h = await setup([], f.fetch);
    expect(await run(['explain', 'what', 'this', 'project', 'does'], h.ctx)).toBe(0);
    const body = f.calls[0]!.body as { tools?: unknown[] };
    expect(body.tools?.length).toBeGreaterThan(5);
  });

  it('answers as a question when the model is recorded as unable to use tools', async () => {
    const f = fakeFetch([() => sseResponse(chat)]);
    h = await setup([], f.fetch);
    await h.ctx.config.update((c) => {
      c.capabilities['openai/gpt-x'] = { tools: false };
    });
    expect(await run(['explain', 'this', 'project'], h.ctx)).toBe(0);
    expect((f.calls[0]!.body as { tools?: unknown }).tools).toBeUndefined();
    expect(h.err.join('\n')).toContain('cannot use tools');
  });

  it('reports a mistyped single command instead of guessing', async () => {
    h = await setup([]);
    expect(await run(['scna'], h.ctx)).toBe(2);
    expect(h.err.join('\n')).toContain('Did you mean "mia scan"');
  });

  it('explains session-only commands', async () => {
    h = await setup([]);
    expect(await run(['undo'], h.ctx)).toBe(2);
    expect(h.err.join('\n')).toContain('interactive session');
  });
});

describe('orientation tools', () => {
  async function env(): Promise<ToolEnv> {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mia-nl-')));
    await fs.writeFile(path.join(dir, 'package.json'), '{"name":"x","scripts":{"test":"vitest"}}');
    await fs.writeFile(path.join(dir, 'a.js'), 'eval(userInput)\n');
    const run0 = async () => ({
      exitCode: 1,
      stdout: '',
      stderr: '',
      timedOut: false,
      truncated: false,
    });
    const index = new RepoIndex(dir, run0, {});
    await index.refresh();
    return {
      root: dir,
      index,
      run: run0,
      env: {},
      platform: 'linux',
      checkpoints: new Checkpoints(dir),
    };
  }
  it('project_overview and audit_project are read-only tools that work', async () => {
    const e = await env();
    const overview = toolByName('project_overview')!;
    const audit = toolByName('audit_project')!;
    expect(overview.risk).toBe('read');
    expect(audit.risk).toBe('read');
    const o = await overview.execute({}, e);
    expect(o.isError).toBe(false);
    expect(o.content).toMatch(/javascript|node|package\.json/i);
    const a = await audit.execute({ mode: 'quick' }, e);
    expect(a.isError).toBe(false);
    expect(a.content).toContain('audit');
    expect((await audit.execute({ mode: 'bogus' }, e)).isError).toBe(true);
    await fs.rm(e.root, { recursive: true, force: true });
  });
});
