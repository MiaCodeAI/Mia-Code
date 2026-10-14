import type { Context } from '../context.js';
import { colorizeDiff } from './diff.js';
import type { AgentHooks, Approval } from './loop.js';

const MAX_DIFF_LINES = 80;

/** Terminal rendering and approval prompts for agent turns. */
export function makeHooks(
  ctx: Context,
  options: { interactive: boolean },
): AgentHooks & { endLine(): void } {
  const { style } = ctx;
  let atLineStart = true;
  const ensureLine = (): void => {
    if (!atLineStart) {
      ctx.print();
      atLineStart = true;
    }
  };
  return {
    endLine: ensureLine,
    onText(text) {
      ctx.write(text);
      atLineStart = text.endsWith('\n');
    },
    onToolStart(_tool, summary) {
      ensureLine();
      ctx.print(style.cyan(`● ${summary}`));
    },
    onToolResult(tool, result) {
      const lines = result.content.split('\n');
      let shown: string[];
      if (tool === 'read_file') shown = [lines[0] ?? ''];
      else if (tool === 'edit_file' || tool === 'write_file' || tool === 'git_commit')
        shown = lines.slice(0, 3);
      else shown = lines.slice(0, 12);
      const extra = lines.length - shown.length;
      const text = shown.map((l) => `  ${l.length > 160 ? `${l.slice(0, 160)}…` : l}`).join('\n');
      ctx.print(result.isError ? style.red(text) : style.dim(text));
      if (extra > 0) ctx.print(style.dim(`  … ${extra} more line(s)`));
    },
    onNotice(message) {
      ensureLine();
      ctx.print(style.yellow(message));
    },
    async approve(request): Promise<Approval> {
      ensureLine();
      ctx.print(style.bold(`Mia wants to ${request.summary}`));
      if (request.preview) {
        const lines = request.preview.split('\n');
        ctx.print(colorizeDiff(lines.slice(0, MAX_DIFF_LINES).join('\n'), style));
        if (lines.length > MAX_DIFF_LINES)
          ctx.print(style.dim(`… ${lines.length - MAX_DIFF_LINES} more diff line(s)`));
      }
      const terminal = ctx.terminal();
      if (!options.interactive || !terminal.interactive) {
        ctx.print(
          style.yellow(
            'No terminal is available to approve this, so it was declined. Use --mode auto-edit or auto to allow it.',
          ),
        );
        return 'no';
      }
      const always =
        request.risk === 'write'
          ? 'a = always allow edits this session'
          : 'a = always allow this exact command';
      for (;;) {
        const answer = await terminal.readLine(
          style.yellow(`Allow? [y]es / [n]o / [a]lways (${always}) > `),
        );
        const a = (answer ?? 'n').trim().toLowerCase();
        if (a === 'y' || a === 'yes') return 'yes';
        if (a === 'n' || a === 'no' || a === '' || answer === null) return 'no';
        if (a === 'a' || a === 'always') return 'always';
        ctx.print(style.dim('Please answer y, n or a.'));
      }
    },
  };
}
