import { Checkpoints } from '../agent/checkpoints.js';
import { colorizeDiff } from '../agent/diff.js';
import { AgentSession } from '../agent/loop.js';
import { PERMISSION_MODES, describeMode, type PermissionMode } from '../agent/policy.js';
import type { Context } from '../context.js';
import { UsageError, UserError } from '../errors.js';
import { ProviderError } from '../providers/errors.js';
import { RepoIndex } from '../repo/index.js';
import { hostOf } from '../security/endpoint.js';
import { estimateCost } from '../session/chat.js';
import { evidenceBudget, groundTurn } from '../session/grounding.js';
import { formatUsage } from '../ui/format.js';
import { flag, parseFlags, str } from './flags.js';
import {
  TASK_FLAGS,
  TASK_USAGE,
  executeTask,
  loadProjectContext,
  parseTaskFlags,
} from './taskrun.js';
import { renderTaskSummary } from '../agent/task.js';
import { SANDBOX_FLAGS, SANDBOX_USAGE, resolveSandbox } from './sandbox.js';
import { isToolsUnsupported } from '../providers/toolsupport.js';
import { openProvider, pickProviderName } from './runtime.js';

/** Thrown when the model cannot use tools, so callers can fall back to a plain answer. */
export class ToolsUnsupportedError extends UserError {}

/** `mia run <task>`: one agent task (reads, edits, runs tests) with the chosen permission mode. */
export async function runCommand(args: string[], ctx: Context): Promise<number> {
  const { values, positionals } = parseFlags(args, {
    provider: { type: 'string' },
    model: { type: 'string' },
    mode: { type: 'string' },
    'max-steps': { type: 'string' },
    'no-context': { type: 'boolean' },
    'no-evidence': { type: 'boolean' },
    diff: { type: 'boolean' },
    ...SANDBOX_FLAGS,
    ...TASK_FLAGS,
  });
  const task = positionals.join(' ').trim();
  if (task === '')
    throw new UsageError(
      `Usage: mia run [--mode ${PERMISSION_MODES.join('|')}] [--max-steps <n>] [--diff] ${TASK_USAGE} ${SANDBOX_USAGE} <task>`,
    );
  const mode = (str(values, 'mode') ?? 'ask') as PermissionMode;
  if (!PERMISSION_MODES.includes(mode))
    throw new UsageError(`--mode must be one of: ${PERMISSION_MODES.join(', ')}`);
  const maxStepsRaw = str(values, 'max-steps');
  const maxSteps = maxStepsRaw === undefined ? 25 : Number(maxStepsRaw);
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 200)
    throw new UsageError('--max-steps must be an integer from 1 to 200');

  const cfg = await ctx.config.load();
  const name = pickProviderName(cfg, str(values, 'provider'));
  const runtime = await openProvider(
    ctx,
    cfg,
    name,
    (info) =>
      ctx.printErr(
        ctx.style.dim(
          `${info.error.code.replace('_', ' ')}; retrying in ${Math.ceil(info.delayMs / 1000)}s`,
        ),
      ),
    (_n, message) => ctx.printErr(ctx.style.yellow(`[key rotation] ${message}`)),
  );
  const model = str(values, 'model') ?? runtime.config.model;
  if (!model)
    throw new UserError(
      `No model selected for "${name}". Run "mia model list ${name}" and "mia model use <id>".`,
    );

  const index = new RepoIndex(ctx.cwd, ctx.run, ctx.env);
  const turn = await groundTurn(index, ctx, task, {
    overview: !flag(values, 'no-context'),
    evidence: !flag(values, 'no-context') && !flag(values, 'no-evidence'),
    budgetChars: evidenceBudget(cfg, name, model),
  });
  if (!turn.overview) await index.refresh();
  ctx.printErr(
    ctx.style.dim(
      `Mia Code agent · ${hostOf(runtime.config.baseUrl)} · ${model} · ${describeMode(mode)}` +
        (turn.files.length > 0 ? ` · excerpts from ${turn.files.join(', ')}` : ''),
    ),
  );

  const sandbox = await resolveSandbox(ctx, values, index, mode);
  if (sandbox) ctx.printErr(ctx.style.dim(`Sandbox: ${sandbox.describe()}`));
  const checkpoints = new Checkpoints(index.inventory.root);
  checkpoints.begin(task);
  const controller = new AbortController();
  const onSigint = (): void => {
    controller.abort();
    ctx.terminal().cancelPending?.();
  };
  process.once('SIGINT', onSigint);
  const session = new AgentSession();
  const project = await loadProjectContext(ctx, index);
  try {
    const report = await executeTask(task, {
      ctx,
      index,
      provider: runtime.provider,
      model,
      config: cfg,
      maxOutputTokens: runtime.config.maxOutputTokens ?? cfg.limits.maxOutputTokens,
      ...(runtime.config.temperature !== undefined
        ? { temperature: runtime.config.temperature }
        : {}),
      mode,
      sandbox,
      checkpoints,
      session,
      grounded: turn,
      project,
      flags: parseTaskFlags(values),
      maxSteps,
      signal: controller.signal,
    });
    if (flag(values, 'diff')) {
      const diff = await checkpoints.diffAll();
      if (diff) ctx.print(colorizeDiff(diff, ctx.style));
    }
    ctx.print(renderTaskSummary(report, ctx.style));
    ctx.printErr(
      ctx.style.dim(
        `${report.steps} step(s), ${report.toolCalls} tool call(s) · ${formatUsage(report.usage, estimateCost(cfg.pricing[`${name}/${model}`], report.usage))}`,
      ),
    );
    if (report.outcome === 'cancelled') return 130;
    if (report.outcome === 'plan-pending') return 0;
    if (report.outcome !== 'done' || report.stop) return 1;
    return report.checks.some((c) => !c.ok) ? 1 : 0;
  } catch (error) {
    ctx.print();
    if (isToolsUnsupported(error))
      throw new ToolsUnsupportedError(
        `${model} on ${name} does not support tool calling, and "mia run" needs it to read, edit and run things.\n  ${(error as ProviderError).message}\n  Choose a model that supports tools ("mia model list ${name}", then "mia model use <id>" or --model <id>). Use "mia ask" for answers only.`,
      );
    if (error instanceof ProviderError) throw new UserError(error.describe());
    throw error;
  } finally {
    process.off('SIGINT', onSigint);
  }
}
