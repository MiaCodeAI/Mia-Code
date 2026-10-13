import type { Context } from '../context.js';
import { UsageError, UserError } from '../errors.js';
import { ProviderError } from '../providers/errors.js';
import { buildSnapshot, renderSnapshot } from '../project/snapshot.js';
import { hostOf } from '../security/endpoint.js';
import { ChatSession, estimateCost } from '../session/chat.js';
import { buildSystemPrompt } from '../session/prompt.js';
import { formatUsage } from '../ui/format.js';
import { flag, parseFlags, str } from './flags.js';
import { openProvider, pickProviderName } from './runtime.js';

/** `mia ask <question>`: one question, streamed answer on stdout, notices on stderr. */
export async function askCommand(args: string[], ctx: Context): Promise<number> {
  const { values, positionals } = parseFlags(args, {
    provider: { type: 'string' },
    model: { type: 'string' },
    'no-context': { type: 'boolean' },
    'show-context': { type: 'boolean' },
  });
  const question = positionals.join(' ').trim();
  const showContext = flag(values, 'show-context');
  if (question === '' && !showContext)
    throw new UsageError(
      'Usage: mia ask [--provider <name>] [--model <id>] [--no-context] <question>',
    );

  const noContext = flag(values, 'no-context');
  const overview = noContext
    ? null
    : renderSnapshot(await buildSnapshot(ctx.cwd, ctx.run, { env: ctx.env }));
  if (showContext) {
    ctx.print(overview ?? '(project overview disabled by --no-context)');
    return 0;
  }

  const cfg = await ctx.config.load();
  const name = pickProviderName(cfg, str(values, 'provider'));
  const runtime = await openProvider(ctx, cfg, name, (info) =>
    ctx.printErr(
      ctx.style.dim(
        `${info.error.code.replace('_', ' ')}; retrying in ${Math.ceil(info.delayMs / 1000)}s (retry ${info.attempt})`,
      ),
    ),
  );
  const model = str(values, 'model') ?? runtime.config.model;
  if (!model)
    throw new UserError(
      `No model selected for "${name}". Run "mia model list ${name}" and "mia model use <id>".`,
    );

  ctx.printErr(
    ctx.style.dim(
      `Sending your question${overview ? ' and a project overview (file names; see --show-context)' : ''} to ${hostOf(runtime.config.baseUrl)} using ${model}.`,
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
      system: buildSystemPrompt(overview),
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
