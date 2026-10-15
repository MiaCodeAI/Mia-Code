import { promises as fs } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, applyEdits, materialize, sh, writeAcceptance } from './lib.js';
import { measureRetrieval } from './retrieval.js';
import { TASKS, type BenchTask } from './tasks.js';

export interface TaskResult {
  id: string;
  kind: string;
  project: string;
  /** Mia exited 0 and the check passes after the hidden acceptance files are added. */
  completed: boolean;
  checkPassed: boolean;
  miaExit: number | null;
  changed: string[];
  /** Fraction of expectedFiles that were changed. */
  fileRecall: number;
  unrelated: string[];
  retrievalRecall: number;
  steps: number | null;
  toolCalls: number | null;
  seconds: number;
}

export interface BenchOptions {
  tasks: BenchTask[];
  /** Command that runs one task. Receives the prompt via argv. Default: the built mia CLI. */
  miaArgs: string[];
  /** Skip the model: apply each task's reference fix instead (tests the runner itself). */
  oracle: boolean;
  timeoutMs: number;
}

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export async function runOne(task: BenchTask, o: BenchOptions): Promise<TaskResult> {
  const started = Date.now();
  const dir = await materialize(task);
  try {
    if (task.mutate) await applyEdits(dir, task.mutate);
    await fs.mkdir(path.join(dir, '.git', 'info'), { recursive: true });
    const g = (cmd: string) => sh(`git ${cmd}`, dir, 60_000);
    await g('init -q');
    await fs.writeFile(path.join(dir, '.git', 'info', 'exclude'), 'node_modules\n');
    await g('add -A');
    await g('-c user.name=bench -c user.email=bench@example.invalid commit -qm baseline');
    const retrieval = await measureRetrieval(task).catch(() => ({ recall: 0 }));

    let miaExit: number | null = 0;
    let steps: number | null = null;
    let toolCalls: number | null = null;
    if (o.oracle) await applyEdits(dir, task.oracle);
    else {
      const cli = path.join(REPO_ROOT, 'dist', 'cli.js');
      const r = await sh(
        `node ${q(cli)} run ${o.miaArgs.map(q).join(' ')} --check ${q(task.check)} ${q(task.prompt)}`,
        dir,
        o.timeoutMs,
      );
      miaExit = r.code;
      const m = /(\d+) step\(s\), (\d+) tool call\(s\)/.exec(r.output);
      if (m) {
        steps = Number(m[1]);
        toolCalls = Number(m[2]);
      }
    }
    const status = await g('status --porcelain=v1 -uall');
    const changed = status.output
      .split('\n')
      .map((l) => l.slice(3).trim())
      .filter((l) => l !== '');
    await writeAcceptance(dir, task);
    const check = await sh(task.check, dir, 180_000);
    const expected = new Set(task.expectedFiles);
    const allowed = new Set([...task.expectedFiles, ...(task.allowedExtra ?? [])]);
    const acceptanceFiles = new Set(Object.keys(task.acceptance ?? {}));
    const real = changed.filter((f) => !acceptanceFiles.has(f));
    return {
      id: task.id,
      kind: task.kind,
      project: task.project,
      completed: miaExit === 0 && check.ok,
      checkPassed: check.ok,
      miaExit,
      changed: real,
      fileRecall:
        task.expectedFiles.length === 0
          ? 1
          : task.expectedFiles.filter((f) => real.includes(f)).length / expected.size,
      unrelated: real.filter((f) => !allowed.has(f)),
      retrievalRecall: retrieval.recall,
      steps,
      toolCalls,
      seconds: Math.round((Date.now() - started) / 100) / 10,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export function summarize(results: readonly TaskResult[]) {
  const n = results.length || 1;
  const mean = (f: (r: TaskResult) => number): number => results.reduce((a, r) => a + f(r), 0) / n;
  const withSteps = results.filter((r) => r.steps !== null);
  return {
    tasks: results.length,
    completionRate: mean((r) => (r.completed ? 1 : 0)),
    checkPassRate: mean((r) => (r.checkPassed ? 1 : 0)),
    changedExpectedFiles: mean((r) => r.fileRecall),
    retrievalRecall: mean((r) => r.retrievalRecall),
    tasksWithUnrelatedChanges: results.filter((r) => r.unrelated.length > 0).length,
    meanSteps: withSteps.length
      ? withSteps.reduce((a, r) => a + (r.steps ?? 0), 0) / withSteps.length
      : null,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const take = (flag: string): string[] =>
    args.flatMap((a, i) => (a === flag ? [args[i + 1] ?? ''] : []));
  const oracle = args.includes('--oracle');
  const ids = take('--task');
  const projects = take('--project');
  const tasks = TASKS.filter(
    (t) =>
      (ids.length === 0 || ids.includes(t.id)) &&
      (projects.length === 0 || projects.includes(t.project)),
  );
  const miaArgs = [
    ...take('--provider').flatMap((p) => ['--provider', p]),
    ...take('--model').flatMap((m) => ['--model', m]),
    '--mode',
    take('--mode')[0] ?? 'auto-edit',
  ];
  if (tasks.length === 0) throw new Error('No tasks matched.');
  if (!oracle) {
    try {
      await fs.access(path.join(REPO_ROOT, 'dist', 'cli.js'));
    } catch {
      throw new Error(
        'Build first: npm run build. The benchmark runs dist/cli.js with your configured provider and key.',
      );
    }
  }
  const results: TaskResult[] = [];
  for (const t of tasks) {
    process.stderr.write(`${t.id} ... `);
    const r = await runOne(t, { tasks, miaArgs, oracle, timeoutMs: 20 * 60_000 });
    results.push(r);
    process.stderr.write(
      `${r.completed ? 'completed' : 'not completed'}${r.unrelated.length ? ` (unrelated: ${r.unrelated.join(', ')})` : ''}\n`,
    );
  }
  const summary = summarize(results);
  const out = { when: new Date().toISOString(), oracle, summary, results };
  await fs.mkdir(path.join(REPO_ROOT, 'bench', 'results'), { recursive: true });
  const file = path.join(
    REPO_ROOT,
    'bench',
    'results',
    `${out.when.replace(/[:.]/g, '-')}${oracle ? '-oracle' : ''}.json`,
  );
  await fs.writeFile(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Wrote ${path.relative(process.cwd(), file)}`);
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
