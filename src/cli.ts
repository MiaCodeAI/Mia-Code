#!/usr/bin/env node
import { askCommand } from './commands/ask.js';
import { authCommand } from './commands/auth.js';
import { configCommand } from './commands/config.js';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { modelCommand } from './commands/model.js';
import { providerCommand } from './commands/provider.js';
import { replCommand } from './commands/repl.js';
import { runCommand } from './commands/run.js';
import { auditCommand, scanCommand, searchCommand } from './commands/repo.js';
import { ConfigError } from './config/schema.js';
import { createDefaultContext, type Context } from './context.js';
import { UsageError, UserError } from './errors.js';
import { helpTopics, mainHelp, topicHelp } from './help.js';
import { routeIntent } from './nl/intent.js';
import { naturalCommand } from './commands/natural.js';
import { suggest } from './util/suggest.js';

type Handler = (args: string[], ctx: Context) => Promise<number>;

const COMMANDS: Record<string, Handler> = {
  init: initCommand,
  ask: askCommand,
  run: runCommand,
  scan: scanCommand,
  search: searchCommand,
  audit: auditCommand,
  doctor: doctorCommand,
  auth: authCommand,
  provider: providerCommand,
  model: modelCommand,
  config: configCommand,
};

/** Runs the CLI and returns the process exit code. Never calls process.exit itself. */
export async function run(argv: string[], ctx: Context): Promise<number> {
  const [first, ...rest] = argv;

  try {
    if (first === '--version' || first === '-v' || first === 'version') {
      ctx.print(ctx.version);
      return 0;
    }
    if (first === '--help' || first === '-h') {
      ctx.print(mainHelp());
      return 0;
    }
    if (first === 'help') {
      const topic = rest[0];
      if (!topic) {
        ctx.print(mainHelp());
        return 0;
      }
      const text = topicHelp(topic);
      if (!text) {
        const hint = suggest(topic, helpTopics());
        throw new UsageError(`No help for "${topic}".${hint ? ` Did you mean "${hint}"?` : ''}`);
      }
      ctx.print(text);
      return 0;
    }
    if (rest.includes('--help') || rest.includes('-h')) {
      const text = first ? topicHelp(first) : undefined;
      ctx.print(text ?? mainHelp());
      return 0;
    }

    if (first === undefined || first.startsWith('-')) {
      return await replCommand(argv, ctx);
    }
    // "mia scan the project", "mia audit this repo": a known command followed by plain words.
    if (argv.length > 1 && !argv.some((a) => a.startsWith('-'))) {
      const routed = routeIntent(argv.join(' '));
      const target = routed?.cli?.[0];
      if (routed?.cli && target === first && COMMANDS[first])
        return await COMMANDS[first](routed.cli.slice(1), ctx);
    }
    const handler = COMMANDS[first];
    if (!handler) return await naturalCommand(argv, ctx, COMMANDS);
    return await handler(rest, ctx);
  } catch (error) {
    if (error instanceof UsageError) {
      ctx.printErr(`mia: ${error.message}`);
      return 2;
    }
    if (error instanceof UserError || error instanceof ConfigError) {
      ctx.printErr(`mia: ${error.message}`);
      return 1;
    }
    ctx.printErr(
      `mia: unexpected error: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (ctx.env['MIA_DEBUG'] && error instanceof Error && error.stack) ctx.printErr(error.stack);
    else
      ctx.printErr(
        'Set MIA_DEBUG=1 for details, and please report it at https://github.com/MiaCodeAI/Mia-Code/issues',
      );
    return 1;
  } finally {
    ctx.closeTerminal();
  }
}

// Run only when executed as the program (not when imported by tests).
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  // A closed pipe (for example `mia ask ... | head`) is not an error worth a stack trace.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') process.exit(0);
      throw error;
    });
  }
  process.exitCode = await run(process.argv.slice(2), createDefaultContext());
}
