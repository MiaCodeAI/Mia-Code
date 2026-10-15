import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateTask } from '../bench/lib.js';
import { measureRetrieval } from '../bench/retrieval.js';
import { TASKS } from '../bench/tasks.js';

describe('benchmark tasks are valid (no model involved)', () => {
  for (const t of TASKS) {
    const heavy = t.project === 'self' && !existsSync('node_modules');
    it.skipIf(heavy)(
      `${t.id}: fails when broken, passes with the reference fix, fix stays in scope`,
      async () => {
        const v = await validateTask(t);
        expect(v.problems).toEqual([]);
      },
      240_000,
    );
  }
  it('has unique ids and some of each kind', () => {
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
    expect(TASKS.some((t) => t.kind === 'bugfix') && TASKS.some((t) => t.kind === 'feature')).toBe(
      true,
    );
  });
});

describe('offline retrieval: evidence selection finds the files a fix must change', () => {
  it('reaches a minimum recall over all tasks', async () => {
    const results = [];
    for (const t of TASKS) results.push(await measureRetrieval(t));
    const recall = results.reduce((n, r) => n + r.recall, 0) / results.length;
    const missed = results
      .filter((r) => r.recall < 1)
      .map((r) => `${r.id}: wanted ${r.expected.join(',')} got ${r.selected.join(',')}`);
    console.log(
      `retrieval recall ${(recall * 100).toFixed(0)}% over ${results.length} tasks\n${missed.join('\n')}`,
    );
    expect(recall).toBeGreaterThanOrEqual(0.8);
  }, 120_000);
});

describe('benchmark runner (oracle mode, no model)', () => {
  it('scores a correct, in-scope solution as completed with no unrelated changes', async () => {
    const { runOne, summarize } = await import('../bench/run.js');
    const fixtures = TASKS.filter((t) => t.project !== 'self').slice(0, 4);
    const results = [];
    for (const t of fixtures)
      results.push(
        await runOne(t, { tasks: fixtures, miaArgs: [], oracle: true, timeoutMs: 60_000 }),
      );
    const s = summarize(results);
    expect(s.completionRate).toBe(1);
    expect(s.changedExpectedFiles).toBe(1);
    expect(s.tasksWithUnrelatedChanges).toBe(0);
  }, 120_000);
});
