import { Checkpoints } from '../agent/checkpoints.js';
import { colorizeDiff } from '../agent/diff.js';
import { AgentSession } from '../agent/loop.js';
import { PERMISSION_MODES, describeMode, type PermissionMode } from '../agent/policy.js';
import { buildAgentPrompt } from '../agent/prompt.js';
import { makeHooks } from '../agent/render.js';
import { ALL_TOOLS } from '../agent/tools.js';
import type { Context } from '../context.js';
import { UsageError, UserError } from '../errors.js';
import { ProviderError } from '../providers/errors.js';
import { RepoIndex } from '../repo/index.js';
import { renderEvidence } from '../repo/evidence.js';
import { hostOf } from '../security/endpoint.js';
import { estimateCost } from '../session/chat.js';
import { evidenceBudget, groundTurn } from '../session/grounding.js';
import { formatUsage } from '../ui/format.js';
import { flag, parseFlags, str } from './flags.js';
import { openProvider, pickProviderName } from './runtime.js';

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
  });
  const task = positionals.join(' ').trim();
  if (task === '')
    throw new UsageError(
      `Usage: mia run [--mode ${PERMISSION_MODES.join('|')}] [--max-steps <n>] [--diff] <task>`,
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

  const checkpoints = new Checkpoints(index.inventory.root);
  checkpoints.begin(task);
  const controller = new AbortController();
  const onSigint = (): void => {
    controller.abort();
    ctx.terminal().cancelPending?.();
  };
  process.once('SIGINT', onSigint);
  const hooks = makeHooks(ctx, { interactive: ctx.terminal().interactive });
  const session = new AgentSession();
  try {
    const result = await session.runTurn(task, {
      provider: runtime.provider,
      model,
      system: buildAgentPrompt({
        overview: turn.overview,
        evidence: turn.bundle ? renderEvidence(turn.bundle) : null,
        mode,
        instructionFiles: index.profile?.instructionFiles ?? [],
      }),
      tools: ALL_TOOLS,
      toolEnv: {
        root: index.inventory.root,
        index,
        run: ctx.run,
        env: ctx.env,
        platform: ctx.platform,
        checkpoints,
        signal: controller.signal,
      },
      mode,
      hooks,
      maxSteps,
      maxOutputTokens: runtime.config.maxOutputTokens ?? cfg.limits.maxOutputTokens,
      ...(runtime.config.temperature !== undefined
        ? { temperature: runtime.config.temperature }
        : {}),
      signal: controller.signal,
    });
    hooks.endLine();
    if (flag(values, 'diff')) {
      const diff = await checkpoints.diffAll();
      if (diff) ctx.print(colorizeDiff(diff, ctx.style));
    }
    if (checkpoints.changedFiles.length > 0)
      ctx.printErr(
        ctx.style.dim(`Changed: ${checkpoints.changedFiles.join(', ')}. Review with "git diff".`),
      );
    ctx.printErr(
      ctx.style.dim(
        `${result.steps} step(s), ${result.toolCalls} tool call(s) · ${formatUsage(result.usage, estimateCost(cfg.pricing[`${name}/${model}`], result.usage))}`,
      ),
    );
    if (result.stop === 'cancelled') return 130;
    return result.stop === 'done' ? 0 : 1;
  } catch (error) {
    ctx.print();
    if (error instanceof ProviderError) throw new UserError(error.describe());
    throw error;
  } finally {
    process.off('SIGINT', onSigint);
  }
}
