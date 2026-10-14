import { promises as fs } from 'node:fs';
import path from 'node:path';
import { unifiedDiff } from './diff.js';

interface Change {
  before: string | null;
  after: string | null;
}

export interface UndoResult {
  restored: string[];
  conflicts: string[];
}

/**
 * Records every file change the agent makes, grouped by turn, so the user can review the combined
 * diff and undo the last turn. Only changes made through the edit/write tools are tracked: files
 * changed by shell commands are not, and nothing survives after the session ends.
 */
export class Checkpoints {
  private readonly turns: { label: string; changes: Map<string, Change> }[] = [];
  private readonly originals = new Map<string, string | null>();
  constructor(private readonly root: string) {}

  begin(label: string): void {
    this.turns.push({ label, changes: new Map() });
  }

  record(rel: string, before: string | null, after: string | null): void {
    if (this.turns.length === 0) this.begin('session');
    const turn = this.turns.at(-1)!;
    const existing = turn.changes.get(rel);
    turn.changes.set(rel, { before: existing ? existing.before : before, after });
    if (!this.originals.has(rel)) this.originals.set(rel, before);
  }

  get changedFiles(): string[] {
    return [...this.originals.keys()].sort();
  }

  /** Number of turns that changed at least one file. */
  get undoableTurns(): number {
    return this.turns.filter((t) => t.changes.size > 0).length;
  }

  private async current(rel: string): Promise<string | null> {
    try {
      return await fs.readFile(path.join(this.root, ...rel.split('/')), 'utf8');
    } catch {
      return null;
    }
  }

  /** Combined diff of everything changed this session, original vs now. */
  async diffAll(): Promise<string> {
    const parts: string[] = [];
    for (const rel of this.changedFiles) {
      const diff = unifiedDiff(rel, this.originals.get(rel) ?? null, await this.current(rel));
      if (diff) parts.push(diff);
    }
    return parts.join('\n');
  }

  /**
   * Reverts the most recent turn that changed files. A file is restored only if it still holds what
   * the agent wrote; if you edited it since, it is left alone and reported as a conflict.
   */
  async undoLast(): Promise<(UndoResult & { label: string }) | null> {
    let turnIndex = this.turns.length - 1;
    while (turnIndex >= 0 && this.turns[turnIndex]!.changes.size === 0) turnIndex--;
    if (turnIndex < 0) return null;
    const turn = this.turns[turnIndex]!;
    const result: UndoResult = { restored: [], conflicts: [] };
    for (const [rel, change] of turn.changes) {
      const now = await this.current(rel);
      if (now !== change.after) {
        result.conflicts.push(rel);
        continue;
      }
      const abs = path.join(this.root, ...rel.split('/'));
      if (change.before === null) await fs.rm(abs, { force: true });
      else await fs.writeFile(abs, change.before, 'utf8');
      result.restored.push(rel);
    }
    // Conflicting files stay in the turn so they are not silently forgotten.
    for (const rel of result.restored) {
      turn.changes.delete(rel);
      const first = this.turns.some((t) => t.changes.has(rel));
      if (!first) this.originals.delete(rel);
    }
    if (turn.changes.size === 0) this.turns.splice(turnIndex, 1);
    return { ...result, label: turn.label };
  }
}
