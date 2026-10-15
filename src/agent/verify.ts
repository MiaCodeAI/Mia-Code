import { redact } from '../security/redact.js';
import type { DetectedCommands } from '../repo/detect.js';
import { runShell, type ToolEnv } from './tools.js';

export interface CheckSpec {
  name: string;
  command: string;
  source: 'flag' | 'MIA.md' | 'detected';
}

export interface CheckResult {
  spec: CheckSpec;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Redacted, trimmed output (the tail, where errors usually are). */
  output: string;
}

/**
 * Picks the checks to run after edits. Explicit --check commands win, then commands listed in
 * MIA.md, then commands detected from project files (typecheck, lint, test; build only when nothing
 * else exists). Detected commands are heuristics: the report says where each one came from.
 */
export function selectChecks(input: {
  explicit: readonly string[];
  fromInstructions: readonly string[];
  detected: DetectedCommands | undefined;
}): CheckSpec[] {
  const named = (cmds: readonly string[], source: CheckSpec['source']): CheckSpec[] =>
    cmds.map((command) => ({ name: command.split(/\s+/).slice(0, 3).join(' '), command, source }));
  if (input.explicit.length > 0) return named(input.explicit, 'flag');
  if (input.fromInstructions.length > 0) return named(input.fromInstructions, 'MIA.md');
  const d = input.detected ?? {};
  const out: CheckSpec[] = [];
  for (const kind of ['typecheck', 'lint', 'test'] as const) {
    const command = d[kind];
    if (command && !out.some((c) => c.command === command))
      out.push({ name: kind, command, source: 'detected' });
  }
  if (out.length === 0 && d.build)
    out.push({ name: 'build', command: d.build, source: 'detected' });
  return out;
}

const TAIL_LINES = 40;
function tail(text: string): string {
  const lines = text.split('\n');
  return lines.length <= TAIL_LINES
    ? text
    : `… (${lines.length - TAIL_LINES} earlier lines omitted)\n${lines.slice(-TAIL_LINES).join('\n')}`;
}

export async function runChecks(
  specs: readonly CheckSpec[],
  env: ToolEnv,
  timeoutMs = 300_000,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const spec of specs) {
    const started = Date.now();
    const r = await runShell(spec.command, env, timeoutMs);
    const exitCode = r.meta?.exitCode ?? null;
    results.push({
      spec,
      ok: !r.isError,
      exitCode,
      timedOut: r.meta?.timedOut ?? false,
      durationMs: Date.now() - started,
      output: redact(tail(r.content)),
    });
  }
  return results;
}

/** Text handed to the model so it can explain and repair failures. */
export function failureReport(results: readonly CheckResult[]): string {
  return results
    .filter((r) => !r.ok)
    .map(
      (r) =>
        `$ ${r.spec.command}\n${r.timedOut ? '[timed out]' : `[exit code ${r.exitCode ?? 'unknown'}]`}\n${r.output}`,
    )
    .join('\n\n');
}
