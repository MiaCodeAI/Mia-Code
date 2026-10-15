import type { MiaConfig } from '../config/schema.js';
import type { Context } from '../context.js';
import { UsageError, UserError } from '../errors.js';
import { describeCapabilities, resolveCapabilities } from '../providers/capabilities.js';
import { ProviderError } from '../providers/errors.js';
import { readGitInfo, type GitInfo } from '../project/git.js';
import { RepoIndex } from '../repo/index.js';
import {
  citationSummary,
  evidenceBudget,
  groundTurn,
  type GroundedTurn,
} from '../session/grounding.js';
import { auditCommand, searchCommand, scanCommand } from './repo.js';
import { Checkpoints } from '../agent/checkpoints.js';
import { colorizeDiff } from '../agent/diff.js';
import { AgentSession } from '../agent/loop.js';
import { SANDBOX_FLAGS, resolveSandbox } from './sandbox.js';
import type { ActiveSandbox } from '../sandbox/index.js';
import { PERMISSION_MODES, describeMode, type PermissionMode } from '../agent/policy.js';
import { buildAgentPrompt } from '../agent/prompt.js';
import { makeHooks } from '../agent/render.js';
import { ALL_TOOLS, type ToolEnv } from '../agent/tools.js';
import { renderEvidence } from '../repo/evidence.js';
import { renderBanner } from '../ui/banner.js';
import { hostOf } from '../security/endpoint.js';
import { ChatSession, estimateCost } from '../session/chat.js';
import { formatCost, formatUsage } from '../ui/format.js';
import { suggest } from '../util/suggest.js';
import { flag, parseFlags, str, type ParsedFlags } from './flags.js';
import { openProvider, pickProviderName, type ProviderRuntime } from './runtime.js';

export const SLASH_COMMANDS: Record<string, string> = {
  '/help': 'Show this list',
  '/status': 'Show project, provider, model and session state',
  '/context': 'Show exactly what project overview is sent to the model',
  '/scan': 'Show the repository map (local only; nothing is sent)',
  '/search': 'Search the project: /search <text> (local only)',
  '/audit': 'Run a read-only audit: /audit [--mode quick|standard|deep|security|deployment]',
  '/mode': 'Show or set the mode: chat, readonly, ask, auto-edit, auto',
  '/diff': 'Show everything the agent changed this session',
  '/undo': "Revert the agent's last set of file changes",
  '/keys': 'Show API keys in rotation and their state (/keys reset to retry parked keys)',
  '/usage': 'Show token usage and cost estimate for this session',
  '/model': 'Show the current model; "/model <id>" switches model for this session',
  '/provider': 'Show the current provider; "/provider <name>" switches for this session',
  '/clear': 'Forget the conversation (keeps provider and model)',
  '/quit': 'Leave Mia Code (also /exit, or Ctrl-D)',
};

interface ReplState {
  runtime: ProviderRuntime;
  model: string | undefined;
  git: GitInfo | null;
  index: RepoIndex;
  overview: string | null;
  evidence: boolean;
  lastTurn: GroundedTurn | null;
  lastQuestion: string | undefined;
  config: MiaConfig;
  session: ChatSession;
  includeContext: boolean;
  mode: PermissionMode | 'chat';
  agent: AgentSession;
  checkpoints: Checkpoints;
  flags: ParsedFlags['values'];
  /** undefined until first resolved. */
  sandbox: ActiveSandbox | null | undefined;
}

async function ensureSandbox(state: ReplState, ctx: Context): Promise<ActiveSandbox | null> {
  if (state.sandbox === undefined) {
    await state.index.refresh();
    state.sandbox = await resolveSandbox(ctx, state.flags, state.index, state.mode);
    if (state.sandbox) ctx.print(ctx.style.dim(`  sandbox: ${state.sandbox.describe()}`));
  }
  return state.sandbox;
}

function combinedTotals(state: ReplState) {
  const c = state.session.totals;
  const a = state.agent.totals;
  return {
    requests: c.requests + a.requests,
    inputTokens: c.inputTokens + a.inputTokens,
    outputTokens: c.outputTokens + a.outputTokens,
    unreported: c.unreported,
  };
}

function costLine(state: ReplState): string {
  const totals = combinedTotals(state);
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
    {
      provider: { type: 'string' },
      model: { type: 'string' },
      'no-context': { type: 'boolean' },
      'no-evidence': { type: 'boolean' },
      mode: { type: 'string' },
      ...SANDBOX_FLAGS,
    },
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
  const modeFlag = str(values, 'mode') ?? 'ask';
  if (modeFlag !== 'chat' && !PERMISSION_MODES.includes(modeFlag as PermissionMode))
    throw new UsageError(`--mode must be one of: chat, ${PERMISSION_MODES.join(', ')}`);
  const runtime = await openProvider(
    ctx,
    config,
    name,
    (info) =>
      ctx.print(
        style.dim(
          `  ${info.error.code.replace('_', ' ')}; retrying in ${Math.ceil(info.delayMs / 1000)}s (retry ${info.attempt})`,
        ),
      ),
    (_n, message) => ctx.print(style.yellow(`[key rotation] ${message}`)),
  );

  const includeContext = !flag(values, 'no-context');
  const index = new RepoIndex(ctx.cwd, ctx.run, ctx.env);
  const evidence = includeContext && !flag(values, 'no-evidence');
  const git = includeContext ? await readGitInfo(ctx.run, ctx.cwd, ctx.env) : null;
  const state: ReplState = {
    runtime,
    model: str(values, 'model') ?? runtime.config.model,
    git,
    index,
    overview: null,
    evidence,
    lastTurn: null,
    lastQuestion: undefined,
    config,
    session: new ChatSession(),
    includeContext,
    mode: modeFlag as PermissionMode | 'chat',
    agent: new AgentSession(),
    checkpoints: new Checkpoints(index.directory),
    flags: values,
    sandbox: undefined,
  };

  const branch = git
    ? `${git.branch ?? '?'}${git.changedPaths ? ` (${git.changedPaths} changed)` : ' (clean)'}`
    : 'no git';
  for (const line of renderBanner(
    style,
    {
      version: ctx.version,
      project: ctx.cwd,
      git: branch,
      provider: `${runtime.name} (${hostOf(runtime.config.baseUrl)})`,
      model: state.model ?? 'NOT SET - use /model <id>',
      keys:
        runtime.keyCount > 1
          ? `${runtime.keyCount} keys, automatic rotation`
          : runtime.keyCount === 1
            ? '1 key'
            : 'none needed',
      mode: state.mode === 'chat' ? 'chat: answers only, no tools' : describeMode(state.mode),
      sends: includeContext
        ? `your messages + a file-name overview${evidence ? ' + excerpts of relevant files' : ''} (see /context)`
        : 'your messages only',
    },
    ctx.columns,
  ))
    ctx.print(line);

  let controller: AbortController | undefined;
  terminal.onInterrupt(() => {
    if (controller) {
      controller.abort();
      terminal.cancelPending?.();
    } else {
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
        const turn = await groundTurn(state.index, ctx, text, {
          overview: state.includeContext,
          evidence: state.evidence,
          budgetChars: evidenceBudget(config, state.runtime.name, state.model),
          ...(state.lastQuestion !== undefined ? { previousQuestion: state.lastQuestion } : {}),
        });
        state.overview = turn.overview;
        state.lastTurn = turn;
        state.lastQuestion = text;
        if (turn.files.length > 0)
          ctx.print(style.dim(`  sending excerpts from: ${turn.files.join(', ')}`));
        if (state.mode !== 'chat') {
          state.checkpoints.begin(text);
          const hooks = makeHooks(ctx, { interactive: terminal.interactive });
          const toolEnv: ToolEnv = {
            root: state.index.inventory.root,
            index: state.index,
            run: ctx.run,
            env: ctx.env,
            platform: ctx.platform,
            checkpoints: state.checkpoints,
            sandbox: await ensureSandbox(state, ctx),
            signal: controller.signal,
          };
          const result = await state.agent.runTurn(text, {
            provider: state.runtime.provider,
            model: state.model,
            system: buildAgentPrompt({
              overview: turn.overview,
              evidence: turn.bundle ? renderEvidence(turn.bundle) : null,
              mode: state.mode,
              instructionFiles: state.index.profile.instructionFiles,
            }),
            tools: ALL_TOOLS,
            toolEnv,
            mode: state.mode,
            hooks,
            maxOutputTokens: state.runtime.config.maxOutputTokens ?? config.limits.maxOutputTokens,
            ...(state.runtime.config.temperature !== undefined
              ? { temperature: state.runtime.config.temperature }
              : {}),
            signal: controller.signal,
          });
          hooks.endLine();
          if (result.stop === 'cancelled') ctx.print(style.yellow('[cancelled]'));
          else {
            const cites = citationSummary(result.text, turn, state.index);
            if (cites) ctx.print(style.dim(cites));
          }
          if (state.checkpoints.undoableTurns > 0 && state.checkpoints.changedFiles.length > 0)
            ctx.print(
              style.dim(
                `Changed this session: ${state.checkpoints.changedFiles.join(', ')}  (/diff to review, /undo to revert the last change set)`,
              ),
            );
          ctx.print(
            style.dim(
              `${result.steps} step(s), ${result.toolCalls} tool call(s) · ${formatUsage(
                result.usage,
                estimateCost(config.pricing[`${state.runtime.name}/${state.model}`], result.usage),
              )}`,
            ),
          );
        } else {
          const result = await state.session.send(text, {
            provider: state.runtime.provider,
            model: state.model,
            system: turn.system,
            maxOutputTokens: state.runtime.config.maxOutputTokens ?? config.limits.maxOutputTokens,
            ...(state.runtime.config.temperature !== undefined
              ? { temperature: state.runtime.config.temperature }
              : {}),
            signal: controller.signal,
            onText: (chunk) => ctx.write(chunk),
          });
          ctx.print();
          if (result.cancelled) ctx.print(style.yellow('[cancelled]'));
          else {
            const cites = citationSummary(result.text, turn, state.index);
            if (cites) ctx.print(style.dim(cites));
            ctx.print(
              style.dim(
                formatUsage(
                  result.usage,
                  estimateCost(
                    config.pricing[`${state.runtime.name}/${state.model}`],
                    result.usage,
                  ),
                ),
              ),
            );
          }
        }
      } catch (error) {
        ctx.print();
        if (error instanceof ProviderError) {
          ctx.print(style.red(error.describe()));
          if (
            error.code === 'bad_request' &&
            state.mode !== 'chat' &&
            /tool|function/i.test(error.message)
          )
            ctx.print(
              style.yellow(
                'This model or endpoint may not support tool calling. Try /mode chat, or another model.',
              ),
            );
        } else ctx.print(style.red(`Unexpected error: ${(error as Error).message}`));
      } finally {
        controller = undefined;
      }
      ctx.print();
    }
  } finally {
    terminal.onInterrupt(undefined);
  }
  ctx.print(
    style.dim(`Session ended. ${combinedTotals(state).requests} request(s); ${costLine(state)}`),
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
      state.agent.clear();
      ctx.print('Conversation cleared.');
      return false;
    case '/context':
      ctx.print(
        state.overview ??
          '(nothing sent yet, or the project overview is disabled for this session)',
      );
      if (state.lastTurn?.bundle && state.lastTurn.bundle.excerpts.length > 0)
        ctx.print(
          '\nExcerpts sent with the last question:\n' +
            state.lastTurn.bundle.excerpts
              .map((e) => `  ${e.path}:${e.startLine}-${e.endLine}  (${e.reason})`)
              .join('\n'),
        );
      return false;
    case '/mode': {
      if (argument === '') {
        ctx.print(
          `Mode: ${state.mode === 'chat' ? 'chat (answers only, no tools)' : describeMode(state.mode)}\nAvailable: chat, ${PERMISSION_MODES.join(', ')}`,
        );
        return false;
      }
      if (argument !== 'chat' && !PERMISSION_MODES.includes(argument as PermissionMode)) {
        ctx.print(
          style.red(`Unknown mode "${argument}". Available: chat, ${PERMISSION_MODES.join(', ')}`),
        );
        return false;
      }
      if (argument === 'auto') {
        try {
          await state.index.refresh();
          state.sandbox = await resolveSandbox(ctx, state.flags, state.index, 'auto');
        } catch (error) {
          if (!(error instanceof UserError)) throw error;
          ctx.print(style.red(error.message));
          return false;
        }
      }
      state.mode = argument as PermissionMode | 'chat';
      ctx.print(
        `Mode: ${state.mode === 'chat' ? 'chat (answers only, no tools)' : describeMode(state.mode)}`,
      );
      return false;
    }
    case '/diff': {
      const diff = await state.checkpoints.diffAll();
      ctx.print(diff === '' ? 'No file changes this session.' : colorizeDiff(diff, style));
      return false;
    }
    case '/undo': {
      const result = await state.checkpoints.undoLast();
      if (!result) {
        ctx.print('Nothing to undo.');
        return false;
      }
      if (result.restored.length > 0) ctx.print(`Reverted: ${result.restored.join(', ')}`);
      for (const c of result.conflicts)
        ctx.print(
          style.yellow(
            `Left ${c} alone: it changed after the agent edited it. Review it with git or /diff.`,
          ),
        );
      ctx.print(
        style.dim(
          'Only edits made by the agent tools are tracked; changes made by shell commands are not undone.',
        ),
      );
      if (result.restored.length > 0)
        state.agent.messages.push({
          role: 'user',
          content: `[The user reverted your last changes to: ${result.restored.join(', ')}.]`,
        });
      return false;
    }
    case '/keys': {
      const pool = state.runtime.pool;
      if (!pool) {
        ctx.print(
          `${state.runtime.keyCount === 1 ? '1 API key' : 'No API key needed'} for "${state.runtime.name}". Add more with "mia auth login ${state.runtime.name} --label <name>".`,
        );
        return false;
      }
      if (argument === 'reset') {
        pool.reset();
        ctx.print('All keys are available again.');
        return false;
      }
      for (const k of pool.status()) {
        const detail =
          k.state === 'ready'
            ? k.active
              ? 'ready (in use)'
              : 'ready'
            : `${k.state}${k.reason ? `: ${k.reason.replace('_', ' ')}` : ''}${k.retryInMs !== undefined ? `, retry in ${Math.ceil(k.retryInMs / 1000)}s` : ''}`;
        ctx.print(`  ${k.label.padEnd(20)} ${k.source.padEnd(22)} ${detail}`);
      }
      return false;
    }
    case '/scan':
      await scanCommand(rest, ctx);
      return false;
    case '/search':
      await searchCommand(rest, ctx);
      return false;
    case '/audit':
      await auditCommand(rest, ctx);
      return false;
    case '/usage': {
      const t = combinedTotals(state);
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
        const runtime = await openProvider(ctx, state.config, argument, undefined, (_n, message) =>
          ctx.print(style.yellow(`[key rotation] ${message}`)),
        );
        state.runtime = runtime;
        state.model = runtime.config.model;
        state.session.clear();
        state.agent.clear();
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
