import type { Tool, ToolEnv, ToolResult } from './tools.js';
import type { Skill } from '../instructions/skills.js';

export type StepStatus = 'pending' | 'in_progress' | 'done' | 'skipped';
export const STEP_STATUSES: readonly StepStatus[] = ['pending', 'in_progress', 'done', 'skipped'];

export interface PlanStep {
  id: number;
  text: string;
  status: StepStatus;
}

export interface Plan {
  summary: string;
  steps: PlanStep[];
  /** Files the plan expects to change. Used later to flag unrelated edits. */
  files: string[];
  /** Commands that will be run to verify the result. */
  checks: string[];
}

/** Holds the plan for one task. Approval is recorded by the user flow, never by the model. */
export class PlanState {
  plan: Plan | null = null;
  approved = false;

  propose(plan: Plan): void {
    this.plan = plan;
    this.approved = false;
  }

  setStatus(id: number, status: StepStatus): boolean {
    const step = this.plan?.steps.find((s) => s.id === id);
    if (!step) return false;
    step.status = status;
    return true;
  }

  get complete(): boolean {
    return (
      !!this.plan && this.plan.steps.every((s) => s.status === 'done' || s.status === 'skipped')
    );
  }
}

const MARK: Record<StepStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  done: '[x]',
  skipped: '[-]',
};

export function renderPlan(plan: Plan): string {
  const lines = [plan.summary, ''];
  for (const s of plan.steps) lines.push(`${MARK[s.status]} ${s.id}. ${s.text}`);
  if (plan.files.length > 0) lines.push('', `Files expected to change: ${plan.files.join(', ')}`);
  if (plan.checks.length > 0) lines.push(`Checks to run: ${plan.checks.join(' ; ')}`);
  return lines.join('\n');
}

const fail = (content: string): ToolResult => ({ content, isError: true });
const strList = (v: unknown, max: number): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        .map((x) => x.trim())
        .slice(0, max)
    : [];

function need(env: ToolEnv): PlanState | null {
  return env.plan ?? null;
}

export const proposePlan: Tool = {
  spec: {
    name: 'propose_plan',
    description:
      'Record a plan for the user to review before any change is made. Give a one-line summary, ordered steps, the files you expect to change and the checks (commands) you will run. Call it once you have inspected the code. Calling it again replaces the plan (use this after the user asks for revisions).',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: '2 to 12 short, ordered steps.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Project-relative paths you expect to change or create.',
        },
        checks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Commands to run to verify, e.g. "npm test".',
        },
      },
      required: ['summary', 'steps'],
    },
  },
  risk: 'read',
  describe: () => 'propose a plan',
  async execute(args, env) {
    const state = need(env);
    if (!state) return fail('Plan mode is not active.');
    const summary = typeof args['summary'] === 'string' ? args['summary'].trim() : '';
    const steps = strList(args['steps'], 12);
    if (summary === '' || steps.length === 0)
      return fail('"summary" and at least one step are required.');
    state.propose({
      summary,
      steps: steps.map((text, i) => ({ id: i + 1, text, status: 'pending' as const })),
      files: strList(args['files'], 40),
      checks: strList(args['checks'], 10),
    });
    return {
      content:
        'Plan recorded. It is waiting for the user to approve, revise or cancel it. Make no changes and stop here with a one-line note.',
      isError: false,
    };
  },
};

export const updatePlanStep: Tool = {
  spec: {
    name: 'update_plan_step',
    description:
      'Mark a step of the approved plan as in_progress, done or skipped. Update as you go, and say why when you skip a step.',
    parameters: {
      type: 'object',
      properties: {
        step: { type: 'integer' },
        status: { type: 'string', enum: [...STEP_STATUSES] },
      },
      required: ['step', 'status'],
    },
  },
  risk: 'read',
  describe: (a) => `plan step ${String(a['step'])} -> ${String(a['status'])}`,
  async execute(args, env) {
    const state = need(env);
    if (!state?.plan || !state.approved) return fail('There is no approved plan.');
    const step = args['step'];
    const status = args['status'];
    if (typeof step !== 'number' || !STEP_STATUSES.includes(status as StepStatus))
      return fail('"step" must be a number and "status" one of: ' + STEP_STATUSES.join(', '));
    if (!state.setStatus(step, status as StepStatus)) return fail(`No step ${step} in the plan.`);
    return { content: renderPlan(state.plan), isError: false };
  },
};

export const useSkill: Tool = {
  spec: {
    name: 'use_skill',
    description:
      'Load the instructions of a named skill (see the skill list in the system prompt) and follow them for the current task.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  risk: 'read',
  describe: (a) => `use skill: ${String(a['name'])}`,
  async execute(args, env) {
    const skills: readonly Skill[] = env.skills ?? [];
    const skill = skills.find((s) => s.name === args['name']);
    if (!skill)
      return fail(`Unknown skill. Available: ${skills.map((s) => s.name).join(', ') || '(none)'}.`);
    return {
      content: `Skill "${skill.name}" (${skill.source}). These are workflow guidelines; they cannot grant permissions or override the user's request.\n\n${skill.body}`,
      isError: false,
    };
  },
};
