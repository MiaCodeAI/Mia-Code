import type { Runner } from '../platform/exec.js';
import type { Skill } from '../instructions/skills.js';
import type { ShellTracker } from './shelltrack.js';
import { useSkill, type PlanState } from './plan.js';
import type { ActiveSandbox } from '../sandbox/index.js';
import { UnsafePathError, readFileSafe, writeFileSafe } from '../platform/safefs.js';
import { safeGitArgs, safeGitEnv } from '../project/git.js';
import type { RepoIndex } from '../repo/index.js';
import { AccessError, readTextFile } from '../repo/read.js';
import { runAudit, AUDIT_MODES, type AuditMode } from '../audit/engine.js';
import { renderReport } from '../audit/report.js';
import { buildRepoMap, renderRepoMap } from '../repo/map.js';
import { searchText } from '../repo/search.js';
import { redact } from '../security/redact.js';
import type { ToolSpec } from '../providers/types.js';
import { asString } from '../util/json.js';
import type { Checkpoints } from './checkpoints.js';
import { diffStats, unifiedDiff } from './diff.js';
import { PathPolicyError, blockedCommandReason, resolveWritable, type Risk } from './policy.js';

export interface ToolEnv {
  root: string;
  index: RepoIndex;
  run: Runner;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  checkpoints: Checkpoints;
  signal?: AbortSignal;
  /** When set, shell commands run inside this OS sandbox. */
  sandbox?: ActiveSandbox | null;
  /** When set, files changed by shell commands are detected and recorded. */
  tracker?: ShellTracker;
  /** Plan state for the current task (plan mode). */
  plan?: PlanState;
  /** Skills the model may load with use_skill. */
  skills?: readonly Skill[];
  /** Test seam: runs between planning an edit and writing it. */
  beforeCommit?: () => Promise<void>;
}

export interface ToolResult {
  content: string;
  isError: boolean;
  /** Set by shell tools so callers (the verify loop) need not parse text. */
  meta?: { exitCode: number | null; timedOut: boolean };
}

export interface Tool {
  spec: ToolSpec;
  risk: Risk;
  /** One line for approval prompts and the activity log. */
  describe(args: Record<string, unknown>): string;
  /** Optional diff or details shown before approval. May return an error to refuse early. */
  preview?(
    args: Record<string, unknown>,
    env: ToolEnv,
  ): Promise<{ text: string } | { error: string }>;
  execute(args: Record<string, unknown>, env: ToolEnv): Promise<ToolResult>;
}

const ok = (content: string): ToolResult => ({ content, isError: false });
const fail = (content: string): ToolResult => ({ content, isError: true });

export const MAX_RESULT_CHARS = 24_000;

export function limitText(text: string, max = MAX_RESULT_CHARS): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.35);
  const tail = max - head;
  return `${text.slice(0, head)}\n… [${text.length - max} characters omitted] …\n${text.slice(-tail)}`;
}

function reqString(args: Record<string, unknown>, name: string): string | ToolResult {
  const v = args[name];
  return typeof v === 'string' ? v : fail(`Missing or invalid "${name}": expected a string.`);
}
function optInt(
  args: Record<string, unknown>,
  name: string,
  min: number,
  max: number,
): number | undefined | ToolResult {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
    return fail(`"${name}" must be an integer from ${min} to ${max}.`);
  return v;
}
const isResult = (v: unknown): v is ToolResult =>
  typeof v === 'object' && v !== null && 'isError' in v;

function accessMessage(error: unknown): string {
  if (error instanceof AccessError || error instanceof PathPolicyError) return error.message;
  return (error as Error).message;
}

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

// --------------------------------------------------------------------- read-only tools

const readFile: Tool = {
  spec: {
    name: 'read_file',
    description:
      'Read a text file from the project with line numbers. Use start_line/end_line for large files. Secret, binary and dependency files cannot be read.',
    parameters: objectSchema(
      {
        path: {
          type: 'string',
          description: 'Path relative to the project root, using / separators.',
        },
        start_line: { type: 'integer', description: '1-based first line (default 1).' },
        end_line: {
          type: 'integer',
          description: 'Last line to return (default: up to 400 lines from start).',
        },
      },
      ['path'],
    ),
  },
  risk: 'read',
  describe: (a) => `read ${asString(a['path']) ?? '?'}`,
  async execute(args, env) {
    const p = reqString(args, 'path');
    if (isResult(p)) return p;
    const start = optInt(args, 'start_line', 1, 10_000_000);
    const end = optInt(args, 'end_line', 1, 10_000_000);
    if (isResult(start)) return start;
    if (isResult(end)) return end;
    try {
      const file = await readTextFile(env.root, p, { maxBytes: 2_000_000 });
      const total = file.lines.length;
      const from = start ?? 1;
      const to = Math.min(total, end ?? from + 399, from + 799);
      if (from > total) return fail(`The file has only ${total} lines.`);
      const width = String(to).length;
      const body = file.lines
        .slice(from - 1, to)
        .map(
          (l, i) =>
            `${String(from + i).padStart(width)}| ${l.length > 600 ? `${l.slice(0, 600)}…` : l}`,
        )
        .join('\n');
      const note =
        to < total
          ? `\n[showing lines ${from}-${to} of ${total}; use start_line/end_line for more]`
          : '';
      return ok(redact(`${file.path} (${total} lines)\n${body}${note}`));
    } catch (error) {
      return fail(accessMessage(error));
    }
  },
};

const listFiles: Tool = {
  spec: {
    name: 'list_files',
    description:
      'List project files (respecting .gitignore and the exclusion policy). Optionally filter by a case-insensitive substring of the path.',
    parameters: objectSchema({
      query: {
        type: 'string',
        description: 'Substring to match in the path, e.g. "auth" or ".test.".',
      },
      max: { type: 'integer', description: 'Maximum results (default 200).' },
    }),
  },
  risk: 'read',
  describe: (a) => `list files${asString(a['query']) ? ` matching "${asString(a['query'])}"` : ''}`,
  async execute(args, env) {
    const max = optInt(args, 'max', 1, 1000);
    if (isResult(max)) return max;
    await env.index.refresh();
    const query = (asString(args['query']) ?? '').toLowerCase();
    const paths = env.index.inventory.files
      .map((f) => f.path)
      .filter((p) => p.toLowerCase().includes(query));
    const shown = paths.slice(0, max ?? 200);
    return ok(
      shown.join('\n') +
        (paths.length > shown.length
          ? `\n… ${paths.length - shown.length} more (narrow the query)`
          : '') || '(no matching files)',
    );
  },
};

const searchCode: Tool = {
  spec: {
    name: 'search_code',
    description:
      'Search file contents (ripgrep when available). Returns path:line: text. Literal by default.',
    parameters: objectSchema(
      {
        pattern: { type: 'string' },
        regex: { type: 'boolean', description: 'Treat pattern as a regular expression.' },
        ignore_case: { type: 'boolean' },
        max_results: { type: 'integer', description: 'Default 60.' },
      },
      ['pattern'],
    ),
  },
  risk: 'read',
  describe: (a) => `search "${asString(a['pattern']) ?? '?'}"`,
  async execute(args, env) {
    const pattern = reqString(args, 'pattern');
    if (isResult(pattern)) return pattern;
    const max = optInt(args, 'max_results', 1, 300);
    if (isResult(max)) return max;
    await env.index.refresh();
    const r = await searchText(env.index.inventory, env.run, {
      patterns: [pattern],
      regex: args['regex'] === true,
      ignoreCase: args['ignore_case'] === true,
      maxResults: max ?? 60,
    });
    if (r.error) return fail(`Invalid pattern: ${r.error}`);
    if (r.hits.length === 0) return ok('No matches.');
    return ok(
      redact(
        r.hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n') +
          (r.truncated ? '\n… more matches exist' : ''),
      ),
    );
  },
};

const findSymbol: Tool = {
  spec: {
    name: 'find_symbol',
    description:
      'Find where functions, classes, types or variables are defined, by name (heuristic, pattern-based).',
    parameters: objectSchema({ name: { type: 'string' } }, ['name']),
  },
  risk: 'read',
  describe: (a) => `find symbol ${asString(a['name']) ?? '?'}`,
  async execute(args, env) {
    const name = reqString(args, 'name');
    if (isResult(name)) return name;
    await env.index.refresh();
    const found = env.index.findSymbols(name, 30);
    return ok(
      found.length === 0
        ? 'No matching symbols.'
        : found.map((s) => `${s.path}:${s.line}  ${s.kind} ${s.name}`).join('\n'),
    );
  },
};

// --------------------------------------------------------------------- git (read-only)

async function git(env: ToolEnv, args: string[], timeoutMs = 20_000) {
  return env.run('git', safeGitArgs(args), {
    cwd: env.root,
    env: safeGitEnv(env.env),
    timeoutMs,
    maxOutputBytes: 2_000_000,
  });
}
const gitOut = (r: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}): ToolResult =>
  r.exitCode === 0
    ? ok(redact(r.stdout.trim() === '' ? '(no output)' : r.stdout))
    : fail(redact(r.error ? 'git is not available.' : r.stderr || `git exited with ${r.exitCode}`));

const gitStatus: Tool = {
  spec: {
    name: 'git_status',
    description: 'Show git status (short format with branch).',
    parameters: objectSchema({}),
  },
  risk: 'read',
  describe: () => 'git status',
  execute: async (_a, env) => gitOut(await git(env, ['status', '--short', '--branch'])),
};

const gitDiff: Tool = {
  spec: {
    name: 'git_diff',
    description:
      'Show uncommitted changes (unstaged by default). Optionally for one path or the staged changes.',
    parameters: objectSchema({ path: { type: 'string' }, staged: { type: 'boolean' } }),
  },
  risk: 'read',
  describe: (a) =>
    `git diff${a['staged'] === true ? ' --staged' : ''}${asString(a['path']) ? ` ${asString(a['path'])}` : ''}`,
  async execute(args, env) {
    const argv = ['diff', '--no-color', ...(args['staged'] === true ? ['--staged'] : [])];
    const p = asString(args['path']);
    if (p) {
      if (p.startsWith('-') || p.includes('..')) return fail('Invalid path.');
      argv.push('--', p);
    }
    const r = gitOut(await git(env, argv));
    return r.isError ? r : ok(limitText(r.content));
  },
};

const gitLog: Tool = {
  spec: {
    name: 'git_log',
    description: 'Show recent commits (one line each).',
    parameters: objectSchema({ max: { type: 'integer', description: 'Default 15.' } }),
  },
  risk: 'read',
  describe: () => 'git log',
  async execute(args, env) {
    const max = optInt(args, 'max', 1, 100);
    if (isResult(max)) return max;
    return gitOut(await git(env, ['log', '--oneline', '--decorate', '-n', String(max ?? 15)]));
  },
};

// --------------------------------------------------------------------- editing

function detectEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

async function previewEdit(
  args: Record<string, unknown>,
  env: ToolEnv,
): Promise<{ text: string } | { error: string }> {
  const plan = await planEdit(args, env);
  if ('error' in plan) return plan;
  return { text: unifiedDiff(plan.rel, plan.before, plan.after) || '(no change)' };
}

interface Plan {
  rel: string;
  abs: string;
  before: string | null;
  after: string;
}

async function planEdit(
  args: Record<string, unknown>,
  env: ToolEnv,
): Promise<Plan | { error: string }> {
  const p = asString(args['path']);
  const oldText = typeof args['old_string'] === 'string' ? args['old_string'] : undefined;
  const newText = typeof args['new_string'] === 'string' ? args['new_string'] : undefined;
  if (!p) return { error: 'Missing "path".' };
  if (oldText === undefined || newText === undefined)
    return { error: 'Both "old_string" and "new_string" are required.' };
  if (oldText === '')
    return { error: '"old_string" must not be empty (use write_file to create a file).' };
  if (oldText === newText) return { error: '"old_string" and "new_string" are identical.' };
  let target;
  try {
    target = await resolveWritable(env.root, p);
  } catch (error) {
    return { error: accessMessage(error) };
  }
  if (!target.exists) return { error: 'The file does not exist. Use write_file to create it.' };
  let file;
  try {
    file = await readTextFile(env.root, target.rel, { maxBytes: 2_000_000 });
  } catch (error) {
    return { error: accessMessage(error) };
  }
  const eol = detectEol(file.text);
  const fix = (s: string): string => (eol === '\r\n' ? s.replace(/\r?\n/g, '\r\n') : s);
  const oldFixed = file.text.includes(oldText) ? oldText : fix(oldText);
  const newFixed = oldFixed === oldText ? newText : fix(newText);
  const count = file.text.split(oldFixed).length - 1;
  if (count === 0)
    return {
      error:
        '"old_string" was not found. It must match the file exactly, including whitespace. Read the file again and copy the text precisely.',
    };
  if (count > 1 && args['replace_all'] !== true)
    return {
      error: `"old_string" appears ${count} times. Include more surrounding lines to make it unique, or set replace_all to true.`,
    };
  const after =
    args['replace_all'] === true
      ? file.text.split(oldFixed).join(newFixed)
      : file.text.replace(oldFixed, () => newFixed);
  return { rel: target.rel, abs: target.abs, before: file.text, after };
}

async function commit(plan: Plan, env: ToolEnv): Promise<void> {
  // Revalidate at the moment of writing: the file must still hold what the edit was planned against,
  // and the write itself never follows symbolic links (see platform/safefs.ts).
  try {
    await env.beforeCommit?.();
    const now = await readFileSafe(env.root, plan.rel);
    if (now !== plan.before)
      throw new PathPolicyError(
        'The file changed since it was read. Read it again and redo the edit.',
      );
    await writeFileSafe(env.root, plan.rel, plan.after, { mustExist: plan.before !== null });
  } catch (error) {
    if (error instanceof UnsafePathError) throw new PathPolicyError(error.message);
    throw error;
  }
  env.checkpoints.record(plan.rel, plan.before, plan.after);
}

const editFile: Tool = {
  spec: {
    name: 'edit_file',
    description:
      'Edit an existing file by replacing an exact piece of text. old_string must match the file exactly (whitespace included) and be unique unless replace_all is true. Read the file first. Prefer small, targeted edits.',
    parameters: objectSchema(
      {
        path: { type: 'string' },
        old_string: { type: 'string', description: 'Exact existing text to replace.' },
        new_string: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
      },
      ['path', 'old_string', 'new_string'],
    ),
  },
  risk: 'write',
  describe: (a) => `edit ${asString(a['path']) ?? '?'}`,
  preview: previewEdit,
  async execute(args, env) {
    const plan = await planEdit(args, env);
    if ('error' in plan) return fail(plan.error);
    try {
      await commit(plan, env);
    } catch (error) {
      return fail(accessMessage(error));
    }
    const s = diffStats(plan.before ?? '', plan.after);
    return ok(`Edited ${plan.rel} (+${s.added} -${s.removed}).`);
  },
};

async function planWrite(
  args: Record<string, unknown>,
  env: ToolEnv,
): Promise<Plan | { error: string }> {
  const p = asString(args['path']);
  const content = typeof args['content'] === 'string' ? args['content'] : undefined;
  if (!p) return { error: 'Missing "path".' };
  if (content === undefined) return { error: 'Missing "content".' };
  if (content.length > 1_000_000) return { error: 'The content is larger than 1 MB.' };
  let target;
  try {
    target = await resolveWritable(env.root, p);
  } catch (error) {
    return { error: accessMessage(error) };
  }
  let before: string | null = null;
  if (target.exists) {
    try {
      before = (await readTextFile(env.root, target.rel, { maxBytes: 2_000_000 })).text;
    } catch (error) {
      return { error: `Cannot overwrite: ${accessMessage(error)}` };
    }
  }
  return { rel: target.rel, abs: target.abs, before, after: content };
}

const writeFile: Tool = {
  spec: {
    name: 'write_file',
    description:
      'Create a new file, or completely replace an existing one, with the given content. For changes to an existing file prefer edit_file.',
    parameters: objectSchema(
      { path: { type: 'string' }, content: { type: 'string', description: 'Full file content.' } },
      ['path', 'content'],
    ),
  },
  risk: 'write',
  describe: (a) => `write ${asString(a['path']) ?? '?'}`,
  async preview(args, env) {
    const plan = await planWrite(args, env);
    if ('error' in plan) return plan;
    return { text: unifiedDiff(plan.rel, plan.before, plan.after) || '(no change)' };
  },
  async execute(args, env) {
    const plan = await planWrite(args, env);
    if ('error' in plan) return fail(plan.error);
    if (plan.before === plan.after) return ok(`${plan.rel} already has this content.`);
    try {
      await commit(plan, env);
    } catch (error) {
      return fail(accessMessage(error));
    }
    return ok(
      `${plan.before === null ? 'Created' : 'Overwrote'} ${plan.rel} (${plan.after.replace(/\n$/, '').split('\n').length} lines).`,
    );
  },
};

// --------------------------------------------------------------------- commands

const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i;

/** Environment for child commands: the user's own, minus anything that looks like a credential. */
export function scrubbedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !SECRET_ENV.test(k)) out[k] = v;
  return out;
}

export async function runShell(
  command: string,
  env: ToolEnv,
  timeoutMs: number,
): Promise<ToolResult> {
  const blocked = blockedCommandReason(command);
  if (blocked) {
    return fail(
      `Blocked: ${blocked}. Mia Code never runs this kind of command itself. If it is really needed, ask the user to run it manually.`,
    );
  }
  const [shell, shellArgs] =
    env.platform === 'win32'
      ? ['cmd.exe', ['/d', '/s', '/c', command]]
      : ['/bin/sh', ['-c', command]];
  const wrapped = env.sandbox
    ? env.sandbox.wrap([shell as string, ...(shellArgs as string[])])
    : { command: shell as string, args: shellArgs as string[] };
  const before = env.tracker ? await env.tracker.snapshot() : null;
  const r = await env.run(wrapped.command, wrapped.args, {
    cwd: env.root,
    env: scrubbedEnv(env.env),
    timeoutMs,
    maxOutputBytes: 2_000_000,
    ...(env.signal ? { signal: env.signal } : {}),
  });
  const parts: string[] = [];
  if (before && env.tracker) {
    const d = await env.tracker.finish(before, env.checkpoints);
    const names = (label: string, xs: string[]): void => {
      if (xs.length > 0)
        parts.push(
          `[files ${label} by this command: ${xs.slice(0, 15).join(', ')}${xs.length > 15 ? ', …' : ''}]`,
        );
    };
    names('added', d.added);
    names('modified', d.modified);
    names('deleted', d.deleted);
  }
  if (r.error) return fail(`Could not start the shell: ${r.error.message}`);
  if (r.timedOut) parts.push(`[timed out after ${Math.round(timeoutMs / 1000)}s and was stopped]`);
  else parts.push(`[exit code ${r.exitCode ?? 'unknown (killed)'}]`);
  if (r.stdout.trim() !== '') parts.push(`stdout:\n${r.stdout.trimEnd()}`);
  if (r.stderr.trim() !== '') parts.push(`stderr:\n${r.stderr.trimEnd()}`);
  if (r.truncated) parts.push('[output was truncated]');
  return {
    content: limitText(redact(parts.join('\n'))),
    isError: r.timedOut || r.exitCode !== 0,
    meta: { exitCode: r.exitCode, timedOut: r.timedOut },
  };
}

const runCommand: Tool = {
  spec: {
    name: 'run_command',
    description:
      'Run a shell command in the project directory (for builds, linters, scripts). Output is captured. Destructive, publishing, deployment, privilege and secret-reading commands are blocked. Environment variables that look like credentials are removed.',
    parameters: objectSchema(
      {
        command: { type: 'string' },
        timeout_seconds: { type: 'integer', description: 'Default 120, maximum 900.' },
      },
      ['command'],
    ),
  },
  risk: 'exec',
  describe: (a) => `run: ${asString(a['command']) ?? '?'}`,
  async execute(args, env) {
    const command = reqString(args, 'command');
    if (isResult(command)) return command;
    const t = optInt(args, 'timeout_seconds', 1, 900);
    if (isResult(t)) return t;
    return runShell(command, env, (t ?? 120) * 1000);
  },
};

const runTests: Tool = {
  spec: {
    name: 'run_tests',
    description:
      'Run the project\'s tests. Uses the test command detected from project files unless "command" is given. Always run tests after changing code.',
    parameters: objectSchema({
      command: { type: 'string', description: 'Override the test command.' },
      timeout_seconds: { type: 'integer', description: 'Default 300, maximum 900.' },
    }),
  },
  risk: 'exec',
  describe: (a) => `run tests: ${asString(a['command']) ?? '(detected command)'}`,
  async execute(args, env) {
    await env.index.refresh();
    const command = asString(args['command']) ?? env.index.profile.commands.test;
    if (!command)
      return fail(
        'No test command was detected. Pass "command" explicitly (for example "npm test" or "pytest").',
      );
    const t = optInt(args, 'timeout_seconds', 1, 900);
    if (isResult(t)) return t;
    const result = await runShell(command, env, (t ?? 300) * 1000);
    return { ...result, content: `$ ${command}\n${result.content}` };
  },
};

const gitCommit: Tool = {
  spec: {
    name: 'git_commit',
    description:
      'Stage the listed paths and create a commit. Only the listed files are staged. Never pushes. Use only when the user asked for a commit.',
    parameters: objectSchema(
      {
        message: { type: 'string' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files to stage (required).',
        },
      },
      ['message', 'paths'],
    ),
  },
  risk: 'exec',
  describe: (a) => `git commit: ${asString(a['message']) ?? '?'}`,
  async execute(args, env) {
    const message = asString(args['message']);
    const paths = Array.isArray(args['paths'])
      ? args['paths'].filter((x): x is string => typeof x === 'string')
      : [];
    if (!message || paths.length === 0)
      return fail('"message" and a non-empty "paths" list are required.');
    for (const p of paths) {
      if (p.startsWith('-') || p.includes('..') || p.startsWith('/'))
        return fail(`Invalid path: ${p}`);
      try {
        await resolveWritable(env.root, p);
      } catch (error) {
        return fail(`Will not stage ${p}: ${accessMessage(error)}`);
      }
    }
    const add = await git(env, ['add', '--', ...paths]);
    if (add.exitCode !== 0) return gitOut(add);
    const done = await git(env, ['commit', '-m', message], 60_000);
    return gitOut(done);
  },
};

const projectOverview: Tool = {
  spec: {
    name: 'project_overview',
    description:
      'Local scan of the project: languages, frameworks, detected test/build commands, key directories and modules, routes, tests, environment variable names and which secret files exist (names only). Use it for "scan the project", "what is this project" and "how is it organised".',
    parameters: objectSchema({}),
  },
  risk: 'read',
  describe: () => 'scan the project',
  async execute(_args, env) {
    await env.index.refresh();
    const { map } = buildRepoMap(env.index);
    return ok(limitText(redact(renderRepoMap(map).join('\n'))));
  },
};

const auditProject: Tool = {
  spec: {
    name: 'audit_project',
    description:
      'Read-only static audit (security, dependencies, deployment, testing, errors, maintainability, documentation, cross-platform). It never changes files. Findings are pattern-based and each states how it was checked; report them with their confidence, do not overstate them.',
    parameters: objectSchema({
      mode: {
        type: 'string',
        enum: [...AUDIT_MODES].filter((m) => m !== 'custom'),
        description: 'Default "standard". "security" and "deployment" focus the audit.',
      },
    }),
  },
  risk: 'read',
  describe: (a) => `audit the project (${asString(a['mode']) ?? 'standard'})`,
  async execute(args, env) {
    const mode = (asString(args['mode']) ?? 'standard') as AuditMode;
    if (!AUDIT_MODES.includes(mode) || mode === 'custom')
      return fail(`Unknown audit mode "${mode}".`);
    await env.index.refresh();
    const result = await runAudit(env.index, env.run, env.env, { mode });
    return ok(limitText(renderReport(result, 'text')));
  },
};

export const ALL_TOOLS: readonly Tool[] = [
  readFile,
  listFiles,
  projectOverview,
  auditProject,
  searchCode,
  findSymbol,
  gitStatus,
  gitDiff,
  gitLog,
  editFile,
  writeFile,
  runCommand,
  runTests,
  gitCommit,
  useSkill,
];

export function toolByName(name: string): Tool | undefined {
  return ALL_TOOLS.find((t) => t.spec.name === name);
}
