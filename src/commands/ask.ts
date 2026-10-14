import type { Context } from '../context.js';
import { UsageError, UserError } from '../errors.js';
import { ProviderError } from '../providers/errors.js';
import { RepoIndex } from '../repo/index.js';
import { hostOf } from '../security/endpoint.js';
import { ChatSession, estimateCost } from '../session/chat.js';
import { citationSummary, evidenceBudget, groundTurn } from '../session/grounding.js';
import { formatUsage } from '../ui/format.js';
import { flag, parseFlags, str } from './flags.js';
import { openProvider, pickProviderName } from './runtime.js';

/** `mia ask <question>`: one question, streamed answer on stdout, notices on stderr. */
export async function askCommand(args: string[], ctx: Context): Promise<number> {
  const { values, positionals } = parseFlags(args, {
    provider: { type: 'string' },
    model: { type: 'string' },
    'no-context': { type: 'boolean' },
    'no-evidence': { type: 'boolean' },
    'show-context': { type: 'boolean' },
  });
  const question = positionals.join(' ').trim();
  const showContext = flag(values, 'show-context');
  if (question === '' && !showContext)
    throw new UsageError(
      'Usage: mia ask [--provider <name>] [--model <id>] [--no-context] [--no-evidence] <question>',
    );

  const noContext = flag(values, 'no-context');
  const noEvidence = noContext || flag(values, 'no-evidence');
  const index = new RepoIndex(ctx.cwd, ctx.run, ctx.env);
  const cfgEarly = await ctx.config.load();
  const nameEarly = str(values, 'provider') ?? cfgEarly.defaultProvider;
  const modelEarly =
    str(values, 'model') ?? (nameEarly ? cfgEarly.providers[nameEarly]?.model : undefined);
  const budgetChars = evidenceBudget(cfgEarly, nameEarly ?? '', modelEarly);
  const turn = await groundTurn(index, ctx, question, {
    overview: !noContext,
    evidence: !noEvidence,
    budgetChars,
  });
  if (showContext) {
    ctx.print(turn.overview ?? '(project overview disabled by --no-context)');
    if (turn.bundle) {
      ctx.print();
      ctx.print(
        turn.bundle.excerpts.length === 0
          ? '(no file excerpts selected for this question)'
          : `File excerpts that would be sent (${turn.bundle.chars} of ${turn.bundle.budgetChars} characters):\n` +
              turn.bundle.excerpts
                .map((e) => `  ${e.path}:${e.startLine}-${e.endLine}  (${e.reason})`)
                .join('\n'),
      );
    }
    return 0;
  }

  const cfg = cfgEarly;
  const name = pickProviderName(cfg, str(values, 'provider'));
  const runtime = await openProvider(
    ctx,
    cfg,
    name,
    (info) =>
      ctx.printErr(
        ctx.style.dim(
          `${info.error.code.replace('_', ' ')}; retrying in ${Math.ceil(info.delayMs / 1000)}s (retry ${info.attempt})`,
        ),
      ),
    (_notice, message) => ctx.printErr(ctx.style.yellow(`[key rotation] ${message}`)),
  );
  const model = str(values, 'model') ?? runtime.config.model;
  if (!model)
    throw new UserError(
      `No model selected for "${name}". Run "mia model list ${name}" and "mia model use <id>".`,
    );

  ctx.printErr(
    ctx.style.dim(
      `Sending your question${turn.overview ? ' and a project overview (file names; see --show-context)' : ''} to ${hostOf(runtime.config.baseUrl)} using ${model}.`,
    ),
  );
  if (turn.files.length > 0)
    ctx.printErr(
      ctx.style.dim(
        `Also sending excerpts from ${turn.files.length} file(s): ${turn.files.join(', ')} (use --no-evidence to avoid this).`,
      ),
    );

  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once('SIGINT', onSigint);
  const session = new ChatSession();
  try {
    const result = await session.send(question, {
      provider: runtime.provider,
      model,
      system: turn.system,
      maxOutputTokens: runtime.config.maxOutputTokens ?? cfg.limits.maxOutputTokens,
      ...(runtime.config.temperature !== undefined
        ? { temperature: runtime.config.temperature }
        : {}),
      signal: controller.signal,
      onText: (text) => ctx.write(text),
    });
    ctx.print();
    if (result.cancelled) {
      ctx.printErr(ctx.style.yellow('[cancelled]'));
      return 130;
    }
    const cites = citationSummary(result.text, turn, index);
    if (cites) ctx.printErr(ctx.style.dim(cites));
    ctx.printErr(
      ctx.style.dim(
        formatUsage(result.usage, estimateCost(cfg.pricing[`${name}/${model}`], result.usage)),
      ),
    );
    return 0;
  } catch (error) {
    ctx.print();
    if (error instanceof ProviderError) throw new UserError(error.describe());
    throw error;
  } finally {
    process.off('SIGINT', onSigint);
  }
}
