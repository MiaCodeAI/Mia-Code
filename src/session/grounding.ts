import type { MiaConfig } from '../config/schema.js';
import type { Context } from '../context.js';
import { resolveCapabilities } from '../providers/capabilities.js';
import { verifyCitations, summarizeCitations } from '../repo/citations.js';
import {
  evidenceFiles,
  gatherEvidence,
  renderEvidence,
  type EvidenceBundle,
} from '../repo/evidence.js';
import type { RepoIndex } from '../repo/index.js';
import { buildOverview } from '../repo/overview.js';
import { buildSystemPrompt } from './prompt.js';

export interface GroundedTurn {
  system: string;
  overview: string | null;
  bundle: EvidenceBundle | null;
  /** Files whose excerpts are sent with this question. */
  files: string[];
}

/** Evidence is limited by config, and to about 30% of the model's context window when that is known. */
export function evidenceBudget(
  config: MiaConfig,
  provider: string,
  model: string | undefined,
): number {
  let budget = config.limits.evidenceChars;
  if (model) {
    const window = resolveCapabilities(config, provider, model).contextWindow;
    if (window) budget = Math.min(budget, Math.max(2000, Math.floor(window * 4 * 0.3)));
  }
  return budget;
}

/** Refreshes the index (so edits since the last turn are seen) and builds overview + evidence for one question. */
export async function groundTurn(
  index: RepoIndex,
  ctx: Context,
  question: string,
  options: { overview: boolean; evidence: boolean; budgetChars: number; previousQuestion?: string },
): Promise<GroundedTurn> {
  if (!options.overview)
    return { system: buildSystemPrompt(null), overview: null, bundle: null, files: [] };
  await index.refresh();
  const { text } = await buildOverview(index, ctx.run, ctx.env);
  let bundle: EvidenceBundle | null = null;
  if (options.evidence) {
    bundle = await gatherEvidence(question, index, ctx.run, {
      budgetChars: options.budgetChars,
      ...(options.previousQuestion !== undefined
        ? { previousQuestion: options.previousQuestion }
        : {}),
    });
  }
  const evidence = bundle ? renderEvidence(bundle) : null;
  return {
    system: buildSystemPrompt({ overview: text, evidence }),
    overview: text,
    bundle,
    files: bundle ? evidenceFiles(bundle) : [],
  };
}

export function citationSummary(
  answer: string,
  turn: GroundedTurn,
  index: RepoIndex,
): string | null {
  if (!turn.bundle) return null;
  return summarizeCitations(verifyCitations(answer, turn.bundle, index.inventory));
}
