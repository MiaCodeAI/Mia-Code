import { promises as fs } from 'node:fs';
import { runCommand } from '../src/platform/exec.js';
import { evidenceFiles, gatherEvidence } from '../src/repo/evidence.js';
import { RepoIndex } from '../src/repo/index.js';
import { applyEdits, materialize } from './lib.js';
import type { BenchTask } from './tasks.js';

export interface RetrievalResult {
  id: string;
  expected: string[];
  selected: string[];
  /** Expected files that were among the selected evidence files. */
  hits: string[];
  recall: number;
  /** Fraction of selected files that were expected (low is normal: evidence includes context). */
  precision: number;
}

/**
 * Offline measure of "does Mia look at the right files": runs only the evidence selector (no model)
 * on the task prompt against the broken project and checks whether the files a correct fix changes
 * are in the excerpts the model would receive.
 */
export async function measureRetrieval(
  task: BenchTask,
  budgetChars = 20_000,
): Promise<RetrievalResult> {
  const dir = await materialize(task);
  try {
    if (task.mutate) await applyEdits(dir, task.mutate);
    const index = new RepoIndex(dir, runCommand, process.env);
    await index.refresh();
    const bundle = await gatherEvidence(task.prompt, index, runCommand, { budgetChars });
    const selected = evidenceFiles(bundle);
    const hits = task.expectedFiles.filter((f) => selected.includes(f));
    return {
      id: task.id,
      expected: task.expectedFiles,
      selected,
      hits,
      recall: task.expectedFiles.length === 0 ? 1 : hits.length / task.expectedFiles.length,
      precision:
        selected.length === 0
          ? 0
          : selected.filter((f) => task.expectedFiles.includes(f)).length / selected.length,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
