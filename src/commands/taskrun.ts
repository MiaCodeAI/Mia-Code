import type { Checkpoints } from '../agent/checkpoints.js';
import type { AgentSession } from '../agent/loop.js';
import type { PermissionMode } from '../agent/policy.js';
import { buildAgentPrompt } from '../agent/prompt.js';
import { makeHooks } from '../agent/render.js';
import { ShellTracker } from '../agent/shelltrack.js';
import { runTask, type TaskReport } from '../agent/task.js';
import { ALL_TOOLS } from '../agent/tools.js';
import { selectChecks } from '../agent/verify.js';
import type { MiaConfig } from '../config/schema.js';
import type { Context } from '../context.js';
import { loadInstructions, renderInstructions, type Instructions } from '../instructions/index.js';
import { loadSkills, type Skill } from '../instructions/skills.js';
import { defaultPathContext } from '../platform/paths.js';
import type { Provider } from '../providers/types.js';
import { renderEvidence } from '../repo/evidence.js';
import type { RepoIndex } from '../repo/index.js';
import type { ActiveSandbox } from '../sandbox/index.js';
import type { GroundedTurn } from '../session/grounding.js';
import type { FlagSpec, ParsedFlags } from './flags.js';
import { flag, str, strs } from './flags.js';
import { UsageError } from '../errors.js';

export const TASK_FLAGS: FlagSpec = {
  plan: { type: 'boolean' },
  check: { type: 'string', multiple: true },
  'no-verify': { type: 'boolean' },
  repair: { type: 'string' },
  review: { type: 'boolean' },
};
export const TASK_USAGE = '[--plan] [--check "<cmd>"]... [--no-verify] [--repair <0-5>] [--review]';

export interface ProjectContext {
  instructions: Instructions;
  skills: Skill[];
}

export async function loadProjectContext(ctx: Context, index: RepoIndex): Promise<ProjectContext> {
  const root = index.inventory.root;
  const paths = { ...defaultPathContext(), platform: ctx.platform, env: ctx.env };
  return { instructions: await loadInstructions(root, paths), skills: await loadSkills(root) };
}

export interface TaskFlags {
  plan: boolean;
  checks: string[];
  verify: boolean;
  repair: number;
  review: boolean;
}

export function parseTaskFlags(values: ParsedFlags['values']): TaskFlags {
  const raw = str(values, 'repair');
  const repair = raw === undefined ? 2 : Number(raw);
  if (!Number.isInteger(repair) || repair < 0 || repair > 5)
    throw new UsageError('--repair must be an integer from 0 to 5');
  return {
    plan: flag(values, 'plan'),
    checks: strs(values, 'check'),
    verify: !flag(values, 'no-verify'),
    repair,
    review: flag(values, 'review'),
  };
}

export interface RunTaskInput {
  ctx: Context;
  index: RepoIndex;
  provider: Provider;
  model: string;
  config: MiaConfig;
  maxOutputTokens: number;
  temperature?: number;
  mode: PermissionMode;
  sandbox: ActiveSandbox | null;
  checkpoints: Checkpoints;
  session: AgentSession;
  grounded: GroundedTurn;
  project: ProjectContext;
  flags: TaskFlags;
  maxSteps?: number;
  signal: AbortSignal;
}

export async function executeTask(task: string, i: RunTaskInput): Promise<TaskReport> {
  const { ctx, index } = i;
  const hooks = makeHooks(ctx, { interactive: ctx.terminal().interactive });
  const checks = selectChecks({
    explicit: i.flags.checks,
    fromInstructions: i.project.instructions.checks,
    detected: index.profile?.commands,
  });
  const instructions = renderInstructions(i.project.instructions);
  const report = await runTask(task, {
    session: i.session,
    turn: {
      provider: i.provider,
      model: i.model,
      maxOutputTokens: i.maxOutputTokens,
      ...(i.temperature !== undefined ? { temperature: i.temperature } : {}),
      ...(i.maxSteps !== undefined ? { maxSteps: i.maxSteps } : {}),
      signal: i.signal,
    },
    buildSystem: (phase, plan) =>
      buildAgentPrompt({
        overview: i.grounded.overview,
        evidence: i.grounded.bundle ? renderEvidence(i.grounded.bundle) : null,
        mode: i.mode,
        instructionFiles: index.profile?.instructionFiles ?? [],
        instructions,
        skills: i.project.skills,
        ...(phase ? { phase } : {}),
        plan,
        harnessChecks: i.flags.verify && checks.length > 0,
      }),
    tools: ALL_TOOLS,
    toolEnv: {
      root: index.inventory.root,
      index,
      run: ctx.run,
      env: ctx.env,
      platform: ctx.platform,
      checkpoints: i.checkpoints,
      sandbox: i.sandbox,
      skills: i.project.skills,
      tracker: new ShellTracker(index.inventory.root, ctx.run, ctx.env),
      signal: i.signal,
    },
    mode: i.mode,
    hooks,
    io: {
      print: (s) => ctx.print(s),
      ask: (p) => ctx.terminal().readLine(ctx.style.yellow(p)),
      interactive: ctx.terminal().interactive,
    },
    checkpoints: i.checkpoints,
    planFirst: i.flags.plan,
    checks,
    verify: i.flags.verify,
    repairRounds: i.flags.repair,
    review: i.flags.review,
  });
  hooks.endLine();
  return report;
}
