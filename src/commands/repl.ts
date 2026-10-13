import type { MiaConfig } from '../config/schema.js';
import type { Context } from '../context.js';
import { UserError } from '../errors.js';
import { describeCapabilities, resolveCapabilities } from '../providers/capabilities.js';
import { ProviderError } from '../providers/errors.js';
import { buildSnapshot, renderSnapshot, type ProjectSnapshot } from '../project/snapshot.js';
import { hostOf } from '../security/endpoint.js';
import { ChatSession, estimateCost } from '../session/chat.js';
import { buildSystemPrompt } from '../session/prompt.js';
import { formatCost, formatUsage } from '../ui/format.js';
import { suggest } from '../util/suggest.js';
import { flag, parseFlags, str } from './flags.js';
import { openProvider, pickProviderName, type ProviderRuntime } from './runtime.js';

export const SLASH_COMMANDS: Record<string, string> = {
  '/help': 'Show this list',
  '/status': 'Show project, provider, model and session state',
  '/context': 'Show exactly what project overview is sent to the model',
  '/usage': 'Show token usage and cost estimate for this session',
  '/model': 'Show the current model; "/model <id>" switches model for this session',
  '/provider': 'Show the current provider; "/provider <name>" switches for this session',
  '/clear': 'Forget the conversation (keeps provider and model)',
  '/quit': 'Leave Mia Code (also /exit, or Ctrl-D)',
};

interface ReplState {
  runtime: ProviderRuntime;
  model: string | undefined;
  snapshot: ProjectSnapshot | null;
  overview: string | null;
  config: MiaConfig;
  session: ChatSession;
  includeContext: boolean;
}

function costLine(state: ReplState): string {
  const { totals } = state.session;
  const price = state.model
    ? state.config.pricing[`${state.runtime.name}/${state.model}`]
    : undefined;
  const cost =
    totals.unreported === 0 && totals.requests > 0
      ? estimateCost(price, { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens })
      : null;
  return formatCost(cost);
}

export async function replCommand(args: string[], ctx: Context): Promise<number> {
  const { values } = parseFlags(
    args,
    { provider: { type: 'string' }, model: { type: 'string' }, 'no-context': { type: 'boolean' } },
    false,
  );
  const { style } = ctx;
  const terminal = ctx.terminal();

  const config = await ctx.config.load();
  if (!config.defaultProvider && !str(values, 'provider')) {
    ctx.print(`Welcome to Mia Code ${ctx.version}.`);
    ctx.print(
      'No AI provider is connected yet. Run "mia init" to set one up (it takes about a minute).',
    );
    return 1;
  }
  const name = pickProviderName(config, str(values, 'provider'));
  const runtime = await openProvider(ctx, config, name, (info) =>
    ctx.print(
      style.dim(
        `  ${info.error.code.replace('_', ' ')}; retrying in ${Math.ceil(info.delayMs / 1000)}s (retry ${info.attempt})`,
      ),
    ),
  );

  const includeContext = !flag(values, 'no-context');
  const snapshot = includeContext ? await buildSnapshot(ctx.cwd, ctx.run, { env: ctx.env }) : null;
  const state: ReplState = {
    runtime,
    model: str(values, 'model') ?? runtime.config.model,
    snapshot,
    overview: snapshot ? renderSnapshot(snapshot) : null,
    config,
    session: new ChatSession(),
    includeContext,
  };

  const branch = snapshot?.git
    ? `${snapshot.git.branch ?? '?'}${snapshot.git.changedPaths ? ` (${snapshot.git.changedPaths} changed)` : ' (clean)'}`
    : 'no git';
  ctx.print(
    style.bold(`Mia Code ${ctx.version}`) +
      style.dim(' - read-only chat (cannot read files, edit or run commands yet)'),
  );
  ctx.print(style.dim(`  project   ${ctx.cwd}`));
  ctx.print(style.dim(`  git       ${branch}`));
  ctx.print(
    style.dim(
      `  provider  ${runtime.name} (${hostOf(runtime.config.baseUrl)})   model ${state.model ?? 'NOT SET - use /model <id>'}`,
    ),
  );
  ctx.print(
    style.dim(
      `  sends     ${includeContext ? 'your messages + a file-name overview of this project (see /context)' : 'your messages only'}`,
    ),
  );
  ctx.print(style.dim('  Type a question, or /help. Ctrl-C cancels a reply; Ctrl-D exits.'));
  ctx.print();

  let controller: AbortController | undefined;
  terminal.onInterrupt(() => {
    if (controller) controller.abort();
    else {
      ctx.print(style.dim('\n(use /quit or Ctrl-D to exit)'));
    }
  });

  try {
    for (;;) {
      const line = await terminal.readLine(style.cyan('mia> '));
      if (line === null) break;
      const text = line.trim();
      if (text === '') continue;

      if (text.startsWith('/')) {
        if (await handleSlash(text, state, ctx)) break;
        continue;
      }
      if (!state.model) {
        ctx.print(
          style.yellow(
            'No model selected. Use /model <id>, or run "mia model list" in another terminal.',
          ),
        );
        continue;
      }

      controller = new AbortController();
      try {
        const result = await state.session.send(text, {
          provider: state.runtime.provider,
          model: state.model,
          system: buildSystemPrompt(state.overview),
          maxOutputTokens: state.runtime.config.maxOutputTokens ?? config.limits.maxOutputTokens,
          ...(state.runtime.config.temperature !== undefined
            ? { temperature: state.runtime.config.temperature }
            : {}),
          signal: controller.signal,
          onText: (chunk) => ctx.write(chunk),
        });
        ctx.print();
        if (result.cancelled) ctx.print(style.yellow('[cancelled]'));
        else
          ctx.print(
            style.dim(
              formatUsage(
                result.usage,
                estimateCost(config.pricing[`${state.runtime.name}/${state.model}`], result.usage),
              ),
            ),
          );
      } catch (error) {
        ctx.print();
        if (error instanceof ProviderError) ctx.print(style.red(error.describe()));
        else ctx.print(style.red(`Unexpected error: ${(error as Error).message}`));
      } finally {
        controller = undefined;
      }
      ctx.print();
    }
  } finally {
    terminal.onInterrupt(undefined);
  }
  ctx.print(
    style.dim(`Session ended. ${state.session.totals.requests} request(s); ${costLine(state)}`),
  );
  return 0;
}

/** Returns true when the session should end. */
async function handleSlash(input: string, state: ReplState, ctx: Context): Promise<boolean> {
  const [command = '', ...rest] = input.split(/\s+/);
  const argument = rest.join(' ').trim();
  const { style } = ctx;

  switch (command) {
    case '/quit':
    case '/exit':
      return true;
    case '/help':
      for (const [cmd, description] of Object.entries(SLASH_COMMANDS))
        ctx.print(`  ${cmd.padEnd(10)} ${description}`);
      return false;
    case '/clear':
      state.session.clear();
      ctx.print('Conversation cleared.');
      return false;
    case '/context':
      ctx.print(state.overview ?? '(project overview is disabled for this session)');
      return false;
    case '/usage': {
      const t = state.session.totals;
      ctx.print(
        `requests ${t.requests} · tokens in ${t.inputTokens.toLocaleString('en-US')} · out ${t.outputTokens.toLocaleString('en-US')}`,
      );
      if (t.unreported > 0)
        ctx.print(
          style.yellow(
            `${t.unreported} request(s) did not report token usage, so totals and cost are incomplete.`,
          ),
        );
      ctx.print(costLine(state));
      return false;
    }
    case '/status': {
      const p = state.runtime;
      ctx.print(`provider  ${p.name} (${p.config.kind}, ${hostOf(p.config.baseUrl)})`);
      ctx.print(`model     ${state.model ?? '(none)'}`);
      ctx.print(`api key   ${p.keySource ?? 'not required'}`);
      ctx.print(`messages  ${state.session.length} in conversation`);
      if (state.model) {
        for (const line of describeCapabilities(
          resolveCapabilities(state.config, p.name, state.model),
        ))
          ctx.print(style.dim(`  ${line}`));
      }
      return false;
    }
    case '/model':
      if (argument === '') {
        ctx.print(`Current model: ${state.model ?? '(none)'}`);
      } else {
        state.model = argument;
        ctx.print(
          `Model for this session: ${argument} (use "mia model use" to make it permanent).`,
        );
      }
      return false;
    case '/provider':
      if (argument === '') {
        ctx.print(
          `Current provider: ${state.runtime.name}. Configured: ${Object.keys(state.config.providers).join(', ')}`,
        );
        return false;
      }
      try {
        const runtime = await openProvider(ctx, state.config, argument);
        state.runtime = runtime;
        state.model = runtime.config.model;
        state.session.clear();
        ctx.print(
          `Switched to "${argument}" (model ${state.model ?? 'not set - use /model <id>'}). The conversation was cleared so it is not sent to a different provider.`,
        );
      } catch (error) {
        ctx.print(style.red(error instanceof UserError ? error.message : (error as Error).message));
      }
      return false;
    default: {
      const hint = suggest(command, Object.keys(SLASH_COMMANDS));
      ctx.print(
        `Unknown command ${command}.${hint ? ` Did you mean ${hint}?` : ''} Type /help for the list.`,
      );
      return false;
    }
  }
}
