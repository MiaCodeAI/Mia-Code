import type { Checkpoints } from './checkpoints.js';
import type { AgentHooks, AgentSession, AgentTurnOptions, AgentTurnResult } from './loop.js';
import { PlanState, proposePlan, renderPlan, updatePlanStep, type Plan } from './plan.js';
import { decide, type PermissionMode } from './policy.js';
import { reviewChanges, type ReviewNote } from './review.js';
import type { Tool, ToolEnv } from './tools.js';
import { failureReport, runChecks, type CheckResult, type CheckSpec } from './verify.js';

export interface TaskIO {
  print(text: string): void;
  /** Returns null at end of input. */
  ask(prompt: string): Promise<string | null>;
  interactive: boolean;
}

export interface TaskOptions {
  session: AgentSession;
  /** Everything for runTurn except the parts the task flow chooses per phase. */
  turn: Omit<AgentTurnOptions, 'system' | 'tools' | 'toolEnv' | 'mode' | 'hooks'>;
  buildSystem(phase: 'plan' | 'execute' | undefined, plan: string | null): string;
  tools: readonly Tool[];
  toolEnv: ToolEnv;
  mode: PermissionMode;
  hooks: AgentHooks;
  io: TaskIO;
  checkpoints: Checkpoints;
  planFirst: boolean;
  checks: readonly CheckSpec[];
  verify: boolean;
  repairRounds: number;
  /** Ask keep/revert for each changed file at the end. */
  review: boolean;
}

export interface TaskReport {
  outcome: 'done' | 'cancelled' | 'plan-pending' | 'plan-rejected' | 'stopped';
  stop?: string;
  plan: Plan | null;
  changed: Array<{ path: string; via: 'tool' | 'shell'; restorable: boolean }>;
  checks: CheckResult[];
  checksSkipped: string | null;
  repairRounds: number;
  notes: ReviewNote[];
  reverted: string[];
  finalText: string;
  steps: number;
  toolCalls: number;
  usage: { inputTokens?: number; outputTokens?: number };
}

const READ_ONLY = (tools: readonly Tool[]): Tool[] => tools.filter((t) => t.risk === 'read');

/**
 * One task from request to summary: optional plan with approval, the agent turn, checks with up to N
 * repair rounds, a pattern-based review, optional per-file keep/revert, and a report built by Mia Code
 * itself (not written by the model).
 */
export async function runTask(task: string, o: TaskOptions): Promise<TaskReport> {
  const report: TaskReport = {
    outcome: 'done',
    plan: null,
    changed: [],
    checks: [],
    checksSkipped: null,
    repairRounds: 0,
    notes: [],
    reverted: [],
    finalText: '',
    steps: 0,
    toolCalls: 0,
    usage: {},
  };
  const note = (r: AgentTurnResult): void => {
    report.finalText = r.text || report.finalText;
    report.steps += r.steps;
    report.toolCalls += r.toolCalls;
    if (r.usage.inputTokens !== undefined)
      report.usage.inputTokens = (report.usage.inputTokens ?? 0) + r.usage.inputTokens;
    if (r.usage.outputTokens !== undefined)
      report.usage.outputTokens = (report.usage.outputTokens ?? 0) + r.usage.outputTokens;
  };
  const state = new PlanState();
  const baseEnv: ToolEnv = { ...o.toolEnv, plan: state };
  const run = (
    text: string,
    phase: 'plan' | 'execute' | undefined,
    tools: readonly Tool[],
    mode: PermissionMode,
  ) =>
    o.session.runTurn(text, {
      ...o.turn,
      system: o.buildSystem(phase, state.plan ? renderPlan(state.plan) : null),
      tools,
      toolEnv: baseEnv,
      mode,
      hooks: o.hooks,
    });

  // ---- 1. plan and approval
  let executeText = task;
  if (o.planFirst) {
    const planTools = [...READ_ONLY(o.tools), proposePlan];
    let text = task;
    for (let round = 0; ; round++) {
      const r = await run(text, 'plan', planTools, 'readonly');
      note(r);
      if (r.stop === 'cancelled') return { ...report, outcome: 'cancelled' };
      if (!state.plan) {
        o.io.print('\nNo plan was proposed, so nothing was changed.');
        return { ...report, outcome: 'stopped', stop: 'no-plan' };
      }
      report.plan = state.plan;
      o.io.print(`\nProposed plan\n${renderPlan(state.plan)}\n`);
      if (!o.io.interactive) {
        o.io.print(
          'No terminal is available to approve the plan, so nothing was changed. Run again in a terminal to approve it.',
        );
        return { ...report, outcome: 'plan-pending' };
      }
      if (round >= 5) {
        o.io.print('Too many revisions; stopping. Nothing was changed.');
        return { ...report, outcome: 'plan-rejected' };
      }
      const a = ((await o.io.ask('Approve this plan? [y]es / [r]evise / [n]o > ')) ?? 'n')
        .trim()
        .toLowerCase();
      if (a === 'y' || a === 'yes') {
        state.approved = true;
        break;
      }
      if (a === 'r' || a === 'revise') {
        const fb = (await o.io.ask('What should change? > ')) ?? '';
        if (fb.trim() === '') continue;
        text = `Revise the plan: ${fb.trim()}`;
        continue;
      }
      o.io.print('Plan rejected. Nothing was changed.');
      return { ...report, outcome: 'plan-rejected' };
    }
    executeText = 'The plan is approved. Carry it out now.';
  }

  // ---- 2. execute
  const execTools = [...o.tools, ...(state.approved ? [updatePlanStep] : [])];
  const r = await run(executeText, 'execute', execTools, o.mode);
  note(r);
  if (r.stop === 'cancelled') return finish(report, o, state, 'cancelled');
  if (r.stop !== 'done') report.stop = r.stop;

  // ---- 3. checks and repair
  if (o.verify && o.checkpoints.allChangedFiles.length > 0) {
    if (o.checks.length === 0)
      report.checksSkipped =
        'no check command was found (use --check "<cmd>" or a ```mia-checks block in MIA.md)';
    else if (o.mode === 'readonly') report.checksSkipped = 'readonly mode';
    else {
      const decision = decide(o.mode, 'exec');
      let allowed = decision === 'allow';
      if (decision === 'ask') {
        const ans = await o.hooks.approve({
          tool: 'verify',
          risk: 'exec',
          summary: `run checks: ${o.checks.map((c) => c.command).join(' ; ')}`,
        });
        allowed = ans !== 'no';
        if (!allowed) report.checksSkipped = 'declined by user';
      }
      if (allowed) {
        for (let round = 0; ; round++) {
          o.io.print(`\nRunning checks: ${o.checks.map((c) => c.command).join(' ; ')}`);
          report.checks = await runChecks(o.checks, baseEnv);
          if (report.checks.every((c) => c.ok) || round >= o.repairRounds) break;
          o.io.print(
            'Checks failed; asking Mia to explain and repair (round ' + (round + 1) + ').',
          );
          report.repairRounds = round + 1;
          const fix = await run(
            `The project checks failed after your changes. Explain briefly what each failure means, then fix the cause. Do not weaken, skip or delete tests to make them pass.\n<check_output>\n${failureReport(report.checks)}\n</check_output>`,
            'execute',
            execTools,
            o.mode,
          );
          note(fix);
          if (fix.stop === 'cancelled') return finish(report, o, state, 'cancelled');
        }
      }
    }
  }
  return finish(report, o, state, report.outcome);
}

async function finish(
  report: TaskReport,
  o: TaskOptions,
  state: PlanState,
  outcome: TaskReport['outcome'],
): Promise<TaskReport> {
  report.outcome = outcome;
  if (state.plan) report.plan = state.plan;
  const cp = o.checkpoints;
  const diffs = new Map<string, string>();
  for (const p of cp.changedFiles) diffs.set(p, await cp.diffFile(p));
  report.notes = reviewChanges({
    changed: cp.allChangedFiles,
    diffs,
    plannedFiles: report.plan?.files ?? [],
  });

  if (o.review && o.io.interactive && cp.changedFiles.length > 0) {
    let keepAll = false;
    for (const p of cp.changedFiles) {
      if (keepAll) break;
      o.io.print(`\n── ${p}\n${diffs.get(p) ?? ''}`);
      const a = ((await o.io.ask('Keep this file? [k]eep / [r]evert / keep [a]ll > ')) ?? 'k')
        .trim()
        .toLowerCase();
      if (a === 'a' || a === 'all') keepAll = true;
      else if (a === 'r' || a === 'revert') {
        const res = await cp.undoFile(p);
        if (res === 'restored') report.reverted.push(p);
        else o.io.print(`Could not revert ${p} (${res}); it was left as is.`);
      }
    }
  }
  report.changed = cp.allChangedFiles.map((p) => ({
    path: p,
    via: cp.viaShell.has(p) ? ('shell' as const) : ('tool' as const),
    restorable: !cp.unrestorable.has(p),
  }));
  return report;
}

/** Summary built from facts the harness observed, not from what the model claims. */
export function renderTaskSummary(
  r: TaskReport,
  style: {
    bold(s: string): string;
    dim(s: string): string;
    red(s: string): string;
    green(s: string): string;
    yellow(s: string): string;
  },
): string {
  const out: string[] = ['', style.bold('Summary')];
  const label: Record<TaskReport['outcome'], string> = {
    done: r.stop ? `stopped early (${r.stop})` : 'finished',
    cancelled: 'cancelled',
    'plan-pending': 'plan awaiting approval',
    'plan-rejected': 'plan not approved',
    stopped: 'stopped',
  };
  out.push(`Status: ${label[r.outcome]}  (${r.steps} model step(s), ${r.toolCalls} tool call(s))`);
  if (r.plan) {
    const done = r.plan.steps.filter((s) => s.status === 'done').length;
    out.push(`Plan: ${done}/${r.plan.steps.length} step(s) marked done`);
    for (const s of r.plan.steps)
      out.push(
        `  ${s.status === 'done' ? '[x]' : s.status === 'skipped' ? '[-]' : '[ ]'} ${s.text}`,
      );
  }
  const kept = r.changed.filter((c) => !r.reverted.includes(c.path));
  out.push(kept.length === 0 ? 'Changed files: none' : `Changed files (${kept.length}):`);
  for (const c of kept)
    out.push(
      `  ${c.path}${c.via === 'shell' ? ' (changed by a shell command)' : ''}${c.restorable ? '' : ' (cannot be undone by Mia; use git)'}`,
    );
  if (r.reverted.length > 0) out.push(`Reverted at your request: ${r.reverted.join(', ')}`);
  if (r.checks.length > 0) {
    out.push('Checks run:');
    for (const c of r.checks)
      out.push(
        `  ${c.ok ? style.green('pass') : style.red('FAIL')}  ${c.spec.command}  (${c.spec.source}${c.timedOut ? ', timed out' : c.ok ? '' : `, exit ${c.exitCode ?? '?'}`})`,
      );
    const bad = r.checks.filter((c) => !c.ok);
    out.push(
      bad.length === 0
        ? 'Remaining failures: none'
        : style.red(`Remaining failures: ${bad.map((b) => b.spec.command).join(' ; ')}`),
    );
    if (r.repairRounds > 0) out.push(`Repair rounds used: ${r.repairRounds}`);
  } else if (r.checksSkipped) out.push(style.yellow(`Checks not run: ${r.checksSkipped}`));
  else if (kept.length > 0) out.push(style.yellow('Checks not run.'));
  if (r.notes.length > 0) {
    out.push('Review notes (pattern-based; verify by reading the diff):');
    for (const n of r.notes) out.push(`  - ${n.path}: ${n.message}`);
  } else if (kept.length > 0)
    out.push(
      style.dim(
        'Review: no pattern-based concerns found (this does not prove the change is correct).',
      ),
    );
  if (kept.length > 0) out.push(style.dim('Undo: /undo in the REPL, or review with git diff.'));
  return out.join('\n');
}
