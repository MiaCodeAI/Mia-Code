import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Checkpoints } from '../src/agent/checkpoints.js';
import { AgentSession, type AgentHooks } from '../src/agent/loop.js';
import { reviewChanges } from '../src/agent/review.js';
import { ShellTracker } from '../src/agent/shelltrack.js';
import { runTask, type TaskOptions } from '../src/agent/task.js';
import { ALL_TOOLS, runShell, type ToolEnv } from '../src/agent/tools.js';
import { selectChecks } from '../src/agent/verify.js';
import { loadInstructions, parseChecks, renderInstructions } from '../src/instructions/index.js';
import { loadSkills } from '../src/instructions/skills.js';
import { defaultPathContext } from '../src/platform/paths.js';
import { runCommand } from '../src/platform/exec.js';
import type { ChatRequest, Provider, StreamEvent, ToolCall } from '../src/providers/types.js';
import { RepoIndex } from '../src/repo/index.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
async function tmp(files: Record<string, string> = {}): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mia-task-')));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
  return dir;
}
const paths = { ...defaultPathContext(), env: { MIA_CONFIG_DIR: '/nonexistent-mia-cfg' } };

describe('instructions', () => {
  it('orders MIA.md before AGENTS.md and extracts checks', async () => {
    const dir = await tmp({
      'MIA.md': 'Use tabs.\n```mia-checks\n# comment\nnpm test\nnpm run lint\n```\n',
      'AGENTS.md': 'Be brief.',
    });
    const i = await loadInstructions(dir, paths);
    expect(i.sources.map((s) => s.name)).toEqual(['MIA.md', 'AGENTS.md']);
    expect(i.checks).toEqual(['npm test', 'npm run lint']);
    const text = renderInstructions(i)!;
    expect(text.indexOf('MIA.md')).toBeLessThan(text.indexOf('AGENTS.md'));
    expect(text).toContain('never grant permissions');
  });

  it('ignores symlinked instruction files and redacts secrets', async () => {
    const dir = await tmp({ 'real.md': 'x' });
    await fs.symlink(path.join(dir, 'real.md'), path.join(dir, 'MIA.md'));
    await fs.writeFile(path.join(dir, 'AGENTS.md'), 'key sk-abcdefghijklmnopqrstuvwxyz0123456789');
    const i = await loadInstructions(dir, paths);
    expect(i.sources.map((s) => s.name)).toEqual(['AGENTS.md']);
    expect(renderInstructions(i)).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('only takes checks from fenced mia-checks blocks', () => {
    expect(parseChecks('npm test\n```js\nrm -rf /\n```')).toEqual([]);
  });

  it('loads global instructions last', async () => {
    const cfg = await tmp({ 'MIA.md': 'global rule' });
    const dir = await tmp({ 'AGENTS.md': 'project rule' });
    const i = await loadInstructions(dir, { ...paths, env: { MIA_CONFIG_DIR: cfg } });
    expect(i.sources.map((s) => s.scope)).toEqual(['project', 'global']);
  });
});

describe('skills', () => {
  it('has built-ins and lets project skills override them', async () => {
    const dir = await tmp({
      '.mia/skills/review-diff/SKILL.md':
        '---\nname: review-diff\ndescription: mine\n---\nCustom review.',
      '.mia/skills/Bad Name/SKILL.md': '---\nname: Bad Name\n---\nx',
      '.mia/skills/deploy-docs/SKILL.md': 'Plain body without frontmatter',
    });
    const skills = await loadSkills(dir);
    const names = skills.map((s) => s.name);
    expect(names).toContain('add-api-endpoint');
    expect(names).toContain('deploy-docs');
    expect(names).not.toContain('Bad Name');
    expect(skills.find((s) => s.name === 'review-diff')).toMatchObject({
      source: 'project',
      description: 'mine',
    });
  });
});

describe('review heuristics', () => {
  const diff = (lines: string[]) => lines.join('\n');
  it('flags unrelated edits, missing tests, weakened tests and leftovers', () => {
    const notes = reviewChanges({
      changed: ['src/a.ts', 'src/b.ts', 'tests/a.test.ts'],
      plannedFiles: ['src/a.ts'],
      diffs: new Map([
        ['src/a.ts', diff(['+++ b', '+console.log("x")', '+try { f() } catch {}'])],
        [
          'tests/a.test.ts',
          diff(['-expect(a).toBe(1)', '-expect(b).toBe(2)', '+it.skip("x", () => {})']),
        ],
      ]),
    });
    const kinds = notes.map((n) => `${n.kind}:${n.path}`);
    expect(kinds).toContain('unrelated-edit:src/b.ts');
    expect(kinds).toContain('unrelated-edit:tests/a.test.ts');
    expect(kinds.filter((k) => k.startsWith('weakened-test')).length).toBe(2);
    expect(kinds).toContain('leftover:src/a.ts');
    expect(kinds).toContain('risky-pattern:src/a.ts');
    expect(kinds.some((k) => k.startsWith('missing-tests'))).toBe(false);
  });
  it('flags source changes without test changes', () => {
    const n = reviewChanges({ changed: ['src/a.ts'], diffs: new Map(), plannedFiles: [] });
    expect(n.map((x) => x.kind)).toEqual(['missing-tests']);
  });
});

describe('selectChecks', () => {
  const detected = {
    test: 'npm test',
    lint: 'npm run lint',
    typecheck: 'npm run typecheck',
    build: 'npm run build',
  };
  it('prefers flags, then MIA.md, then detected (without build)', () => {
    expect(selectChecks({ explicit: ['a'], fromInstructions: ['b'], detected })[0]?.source).toBe(
      'flag',
    );
    expect(selectChecks({ explicit: [], fromInstructions: ['b'], detected })[0]?.source).toBe(
      'MIA.md',
    );
    expect(
      selectChecks({ explicit: [], fromInstructions: [], detected }).map((c) => c.command),
    ).toEqual(['npm run typecheck', 'npm run lint', 'npm test']);
    expect(
      selectChecks({ explicit: [], fromInstructions: [], detected: { build: 'make' } }).map(
        (c) => c.command,
      ),
    ).toEqual(['make']);
  });
});

async function gitRepo(): Promise<string> {
  const dir = await tmp({ 'a.txt': 'one\n', 'b.txt': 'two\n', 'c.txt': 'three\n' });
  const g = (...a: string[]) => runCommand('git', a, { cwd: dir });
  await g('init', '-q');
  await g('add', '.');
  await g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return dir;
}

describe('shell change tracking', () => {
  it('records shell edits, restores clean tracked files, and flags what it cannot restore', async () => {
    const dir = await gitRepo();
    await fs.writeFile(path.join(dir, 'c.txt'), 'three dirty\n'); // dirty before the command
    const index = new RepoIndex(dir, runCommand, {});
    await index.refresh();
    const checkpoints = new Checkpoints(dir);
    checkpoints.begin('t');
    const env: ToolEnv = {
      root: dir,
      index,
      run: runCommand,
      env: process.env,
      platform: process.platform === 'win32' ? 'win32' : 'linux',
      checkpoints,
      tracker: new ShellTracker(dir, runCommand, process.env),
    };
    const r = await runShell(
      'echo changed > a.txt && echo new > n.txt && echo more >> c.txt',
      env,
      20_000,
    );
    expect(r.content).toContain('modified by this command');
    expect(r.content).toContain('added by this command: n.txt');
    expect(checkpoints.allChangedFiles).toEqual(['a.txt', 'c.txt', 'n.txt']);
    expect(checkpoints.unrestorable.has('c.txt')).toBe(true);
    expect(checkpoints.unrestorable.has('a.txt')).toBe(false);
    expect(await checkpoints.undoFile('a.txt')).toBe('restored');
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('one\n');
    expect(await checkpoints.undoFile('n.txt')).toBe('restored');
    await expect(fs.stat(path.join(dir, 'n.txt'))).rejects.toThrow();
    expect(await checkpoints.undoFile('c.txt')).toBe('unknown');
  });

  it('refuses per-file undo when the file changed since', async () => {
    const dir = await tmp({ 'x.txt': 'v0' });
    const cp = new Checkpoints(dir);
    cp.begin('t');
    await fs.writeFile(path.join(dir, 'x.txt'), 'v1');
    cp.record('x.txt', 'v0', 'v1');
    await fs.writeFile(path.join(dir, 'x.txt'), 'edited by user');
    expect(await cp.undoFile('x.txt')).toBe('conflict');
    expect(await fs.readFile(path.join(dir, 'x.txt'), 'utf8')).toBe('edited by user');
  });
});

// ------------------------------------------------------------ the task flow with a scripted model

function scripted(turns: StreamEvent[][]): Provider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let i = 0;
  return {
    name: 'fake',
    kind: 'openai-compatible',
    baseUrl: 'https://x.test',
    requests,
    listModels: async () => [],
    async *streamChat(req) {
      requests.push(JSON.parse(JSON.stringify(req)) as ChatRequest);
      for (const e of turns[i++] ?? [{ type: 'text', text: 'done' }, { type: 'done' }]) yield e;
    },
  };
}
const say = (text: string): StreamEvent[] => [{ type: 'text', text }, { type: 'done' }];
const use = (name: string, args: Record<string, unknown>, id = 'c'): StreamEvent[] => [
  { type: 'tool_call', call: { id, name, arguments: args } satisfies ToolCall },
  { type: 'done' },
];

async function harness(
  files: Record<string, string>,
  answers: string[],
  over: Partial<TaskOptions> = {},
) {
  const dir = await tmp(files);
  const index = new RepoIndex(
    dir,
    async () => ({ exitCode: 1, stdout: '', stderr: '', timedOut: false, truncated: false }),
    {},
  );
  await index.refresh();
  const checkpoints = new Checkpoints(dir);
  checkpoints.begin('t');
  const printed: string[] = [];
  const asked: string[] = [];
  const hooks: AgentHooks = { approve: async () => 'yes' };
  const provider = scripted([]);
  const o = (turns: StreamEvent[][]): TaskOptions => {
    const p = scripted(turns);
    Object.assign(provider, p);
    return {
      session: new AgentSession(),
      turn: { provider: p, model: 'm', maxSteps: 10 },
      buildSystem: (phase) => `system:${phase ?? 'normal'}`,
      tools: ALL_TOOLS,
      toolEnv: {
        root: dir,
        index,
        run: runner,
        env: {},
        platform: 'linux',
        checkpoints,
      },
      mode: 'auto-edit',
      hooks,
      io: {
        print: (s) => printed.push(s),
        ask: async (q) => {
          asked.push(q);
          return answers.shift() ?? null;
        },
        interactive: true,
      },
      checkpoints,
      planFirst: false,
      checks: [],
      verify: true,
      repairRounds: 2,
      review: false,
      ...over,
    };
  };
  let runner = async (c: string, a: readonly string[]) => runCommand(c, a, { cwd: dir });
  return {
    dir,
    o,
    printed,
    asked,
    provider,
    setRunner: (r: typeof runner) => {
      runner = r;
    },
  };
}

describe('plan mode', () => {
  const plan = {
    summary: 'Rename x',
    steps: ['edit a.txt', 'run tests'],
    files: ['a.txt'],
    checks: ['npm test'],
  };

  it('changes nothing until approved, then executes and tracks steps', async () => {
    const h = await harness({ 'a.txt': 'old\n' }, ['y']);
    const opts = h.o([
      use('propose_plan', plan),
      say('plan ready'),
      use('update_plan_step', { step: 1, status: 'in_progress' }, 'u1'),
      use('edit_file', { path: 'a.txt', old_string: 'old', new_string: 'new' }, 'e1'),
      use('update_plan_step', { step: 1, status: 'done' }, 'u2'),
      say('finished'),
    ]);
    const report = await runTask('rename', { ...opts, planFirst: true });
    expect(report.outcome).toBe('done');
    expect(await fs.readFile(path.join(h.dir, 'a.txt'), 'utf8')).toBe('new\n');
    expect(report.plan?.steps[0]?.status).toBe('done');
    expect(report.plan?.steps[1]?.status).toBe('pending');
    // plan phase offered no write tools
    const planTools = h.provider.requests[0]!.tools!.map((t) => t.name);
    expect(planTools).toContain('propose_plan');
    expect(planTools).not.toContain('edit_file');
    expect(planTools).not.toContain('run_command');
    expect(h.provider.requests.at(-1)!.tools!.map((t) => t.name)).toContain('update_plan_step');
  });

  it('lets the user revise, then reject, and leaves files untouched', async () => {
    const h = await harness({ 'a.txt': 'old\n' }, ['r', 'also update docs', 'n']);
    const opts = h.o([
      use('propose_plan', plan),
      say('ok'),
      use('propose_plan', { ...plan, steps: ['a', 'b', 'docs'] }, 'p2'),
      say('revised'),
    ]);
    const report = await runTask('rename', { ...opts, planFirst: true });
    expect(report.outcome).toBe('plan-rejected');
    expect(report.plan?.steps).toHaveLength(3);
    expect(await fs.readFile(path.join(h.dir, 'a.txt'), 'utf8')).toBe('old\n');
    const second = h.provider.requests.find((r) =>
      r.messages.some((m) => m.content.includes('also update docs')),
    );
    expect(second).toBeTruthy();
  });

  it('does not run without a terminal to approve', async () => {
    const h = await harness({ 'a.txt': 'old\n' }, []);
    const opts = h.o([use('propose_plan', plan), say('ok')]);
    const report = await runTask('x', {
      ...opts,
      planFirst: true,
      io: { ...opts.io, interactive: false },
    });
    expect(report.outcome).toBe('plan-pending');
  });

  it('the model cannot approve its own plan', async () => {
    const h = await harness({ 'a.txt': 'old\n' }, ['n']);
    const opts = h.o([
      use('propose_plan', plan),
      use('update_plan_step', { step: 1, status: 'done' }, 'u'),
      say('x'),
    ]);
    const report = await runTask('x', { ...opts, planFirst: true });
    expect(report.plan?.steps[0]?.status).toBe('pending');
  });
});

describe('verify and repair loop', () => {
  it('runs checks after edits, feeds failures back, repairs, and reports truthfully', async () => {
    const h = await harness({ 'a.txt': 'bad\n' }, []);
    const opts = h.o([
      use('edit_file', { path: 'a.txt', old_string: 'bad', new_string: 'still-bad' }, 'e1'),
      say('done?'),
      use('edit_file', { path: 'a.txt', old_string: 'still-bad', new_string: 'good' }, 'e2'),
      say('fixed'),
    ]);
    const report = await runTask('fix', {
      ...opts,
      checks: [{ name: 'grep', command: 'grep -q good a.txt', source: 'flag' }],
    });
    expect(report.repairRounds).toBe(1);
    expect(report.checks.every((c) => c.ok)).toBe(true);
    const repairRequest = h.provider.requests.find((r) =>
      r.messages.some((m) => m.content.includes('<check_output>')),
    );
    expect(repairRequest).toBeTruthy();
    expect(
      repairRequest!.messages.find((m) => m.content.includes('<check_output>'))!.content,
    ).toContain('grep -q good a.txt');
  });

  it('stops after the repair limit and lists remaining failures', async () => {
    const h = await harness({ 'a.txt': 'x\n' }, []);
    const opts = h.o([
      use('edit_file', { path: 'a.txt', old_string: 'x', new_string: 'y' }),
      say('a'),
      say('b'),
      say('c'),
    ]);
    const report = await runTask('t', {
      ...opts,
      repairRounds: 1,
      checks: [{ name: 'f', command: 'false', source: 'flag' }],
    });
    expect(report.checks[0]?.ok).toBe(false);
    expect(report.repairRounds).toBe(1);
  });

  it('does not run checks when nothing changed, or when approval is declined', async () => {
    const h = await harness({ 'a.txt': 'x\n' }, []);
    const none = await runTask('t', {
      ...h.o([say('nothing to do')]),
      checks: [{ name: 'f', command: 'false', source: 'flag' }],
    });
    expect(none.checks).toEqual([]);
    const h2 = await harness({ 'a.txt': 'x\n' }, []);
    const base = h2.o([
      use('edit_file', { path: 'a.txt', old_string: 'x', new_string: 'y' }),
      say('ok'),
    ]);
    const declined = await runTask('t', {
      ...base,
      mode: 'ask',
      hooks: { approve: async (r) => (r.tool === 'verify' ? 'no' : 'yes') },
      checks: [{ name: 'f', command: 'false', source: 'flag' }],
    });
    expect(declined.checksSkipped).toBe('declined by user');
  });

  it('review step reverts only the files the user rejects', async () => {
    const h = await harness({ 'a.txt': 'a\n', 'b.txt': 'b\n' }, ['k', 'r']);
    const opts = h.o([
      use('edit_file', { path: 'a.txt', old_string: 'a', new_string: 'A' }, 'e1'),
      use('edit_file', { path: 'b.txt', old_string: 'b', new_string: 'B' }, 'e2'),
      say('done'),
    ]);
    const report = await runTask('t', { ...opts, review: true });
    expect(report.reverted).toEqual(['b.txt']);
    expect(await fs.readFile(path.join(h.dir, 'a.txt'), 'utf8')).toBe('A\n');
    expect(await fs.readFile(path.join(h.dir, 'b.txt'), 'utf8')).toBe('b\n');
  });
});
