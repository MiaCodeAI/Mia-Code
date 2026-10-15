import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BenchTask, Edit } from './tasks.js';

function findRepoRoot(): string {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  while (!existsSync(path.join(dir, 'bench', 'fixtures')) && path.dirname(dir) !== dir)
    dir = path.dirname(dir);
  return dir;
}
export const REPO_ROOT = findRepoRoot();

export function sh(
  command: string,
  cwd: string,
  timeoutMs = 120_000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const add = (d: Buffer): void => {
      if (output.length < 200_000) output += d.toString();
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, output: String(e) });
    });
  });
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  await walk(root);
  return out;
}

/** Copies the task's project into a fresh temp directory (the repo itself for "self" tasks). */
export async function materialize(task: BenchTask): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `mia-bench-${task.id}-`)));
  const source =
    task.project === 'self' ? REPO_ROOT : path.join(REPO_ROOT, 'bench', 'fixtures', task.project);
  let files = await listFiles(source);
  if (task.project === 'self')
    // Never hand the model the benchmark's own answers: only the detection cases file is needed by a test.
    files = files.filter(
      (f) =>
        !f.startsWith('dist/') &&
        !f.startsWith('coverage/') &&
        (!f.startsWith('bench/') || f === 'bench/detect-cases.ts'),
    );
  for (const f of files) {
    await fs.mkdir(path.dirname(path.join(dir, f)), { recursive: true });
    await fs.copyFile(path.join(source, f), path.join(dir, f));
  }
  if (task.project === 'self')
    await fs.symlink(path.join(REPO_ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  return dir;
}

export async function applyEdits(dir: string, edits: readonly Edit[]): Promise<void> {
  for (const e of edits) {
    const file = path.join(dir, e.file);
    if (e.write !== undefined) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, e.write);
    } else if (e.append !== undefined) {
      await fs.appendFile(file, e.append);
    } else {
      const text = await fs.readFile(file, 'utf8');
      const first = text.indexOf(e.from ?? '\0');
      if (first === -1 || text.indexOf(e.from!, first + 1) !== -1)
        throw new Error(
          `Edit for ${e.file} needs "from" to occur exactly once: ${JSON.stringify(e.from)}`,
        );
      await fs.writeFile(
        file,
        text.replace(e.from!, () => e.to ?? ''),
      );
    }
  }
}

export async function writeAcceptance(dir: string, task: BenchTask): Promise<void> {
  for (const [rel, text] of Object.entries(task.acceptance ?? {})) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text);
  }
}

export interface Validation {
  id: string;
  ok: boolean;
  problems: string[];
}

/** Checks the task itself: it must fail before the reference fix, pass after, and the fix must stay in scope. */
export async function validateTask(task: BenchTask): Promise<Validation> {
  const problems: string[] = [];
  const dir = await materialize(task);
  try {
    if (task.mutate) await applyEdits(dir, task.mutate);
    await writeAcceptance(dir, task);
    const before = await sh(task.check, dir, 180_000);
    if (before.ok) problems.push('check passes before the fix (task is not a real failure)');
    await applyEdits(dir, task.oracle);
    const after = await sh(task.check, dir, 180_000);
    if (!after.ok)
      problems.push(`check still fails after the reference fix:\n${after.output.slice(-600)}`);
    const touched = new Set(task.oracle.map((e) => e.file));
    const allowed = new Set([...task.expectedFiles, ...(task.allowedExtra ?? [])]);
    for (const f of touched)
      if (!allowed.has(f)) problems.push(`reference fix touches ${f}, which is not expected`);
    for (const f of task.expectedFiles)
      if (!touched.has(f)) problems.push(`expected file ${f} is not changed by the reference fix`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  return { id: task.id, ok: problems.length === 0, problems };
}
