import type { Context } from '../context.js';
import { UsageError } from '../errors.js';
import { routeIntent } from '../nl/intent.js';
import { resolveCapabilities } from '../providers/capabilities.js';
import { suggest } from '../util/suggest.js';
import { askCommand } from './ask.js';
import { ToolsUnsupportedError, runCommand } from './run.js';

type Handler = (args: string[], ctx: Context) => Promise<number>;

/**
 * `mia <anything that is not a command>`: understood as plain English.
 * 1. A request that means one of Mia's own commands ("scan project", "run a security audit",
 *    "list models", "set up") runs that command.
 * 2. Anything else is a task for the agent (`mia run`, which asks before changing anything). If the
 *    selected model cannot use tools, the request is answered as a question instead (`mia ask`).
 * A single unknown word that looks like a mistyped command is reported as a typo instead.
 */
export async function naturalCommand(
  words: string[],
  ctx: Context,
  commands: Record<string, Handler>,
): Promise<number> {
  const text = words.join(' ').trim();
  if (words.length === 1 && !/[?\s]/.test(text)) {
    const hint = suggest(text, [...Object.keys(commands), 'help']);
    if (hint)
      throw new UsageError(
        `Unknown command "${text}". Did you mean "mia ${hint}"? Run "mia help" for the list.`,
      );
  }
  const routed = routeIntent(text);
  if (routed?.cli) {
    const [command = '', ...rest] = routed.cli;
    ctx.printErr(ctx.style.dim(`→ mia ${routed.cli.join(' ')}`));
    const handler = commands[command];
    if (handler) return handler(rest, ctx);
  } else if (routed) {
    ctx.printErr(
      ctx.style.yellow(
        routed.say ??
          `"${text}" is a command for an interactive session. Start one with "mia", then say it there.`,
      ),
    );
    return 2;
  }

  const cfg = await ctx.config.load();
  const name = cfg.defaultProvider;
  const model = name ? cfg.providers[name]?.model : undefined;
  const noTools = name && model && resolveCapabilities(cfg, name, model).tools === false;
  if (noTools) {
    ctx.printErr(
      ctx.style.dim(
        `${model} cannot use tools, so this is answered as a question (no file changes).`,
      ),
    );
    return askCommand(words, ctx);
  }
  try {
    return await runCommand(words, ctx);
  } catch (error) {
    if (!(error instanceof ToolsUnsupportedError)) throw error;
    ctx.printErr(
      ctx.style.yellow(`${error.message.split('\n')[0]} Answering as a question instead.`),
    );
    return askCommand(words, ctx);
  }
}
