import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readFileSafe } from '../platform/safefs.js';

export interface Skill {
  name: string;
  description: string;
  body: string;
  source: 'built-in' | 'project';
}

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MAX_SKILL_BYTES = 8_000;

export const BUILTIN_SKILLS: readonly Skill[] = [
  {
    name: 'add-api-endpoint',
    description:
      "Add an HTTP endpoint following the project's existing routing, validation and test conventions",
    source: 'built-in',
    body: [
      '1. Find an existing, similar endpoint (search for routes/handlers) and read it, its validation, its error handling and its test.',
      '2. Add the new route next to the existing ones using the same framework idioms, naming and response shape.',
      '3. Validate all input at the boundary; return the same error format the project already uses.',
      '4. Add tests beside the existing endpoint tests covering success, invalid input and an auth/permission failure if the project has auth.',
      '5. Run the tests and linter. Update API docs or OpenAPI files only if the project already keeps them.',
      'Do not add dependencies unless the user agrees.',
    ].join('\n'),
  },
  {
    name: 'review-diff',
    description:
      'Review the current uncommitted changes for bugs, missing tests and unrelated edits',
    source: 'built-in',
    body: [
      '1. Run git_status and git_diff. Do not modify files in this skill.',
      '2. For each changed file: likely bugs (off-by-one, null handling, error paths, concurrency), security issues, and behaviour changes not mentioned by the user.',
      '3. List changed source files that have no corresponding test change, and any edits unrelated to the stated task.',
      '4. Report findings as a list: `path:line` - problem - suggested fix, ordered by severity. Say plainly when you found nothing, and what you did not check.',
    ].join('\n'),
  },
  {
    name: 'fix-failing-tests',
    description: 'Diagnose and fix failing tests without weakening them',
    source: 'built-in',
    body: [
      '1. Run the tests and read the first failure fully; identify whether the code or the test is wrong.',
      '2. Reproduce with the narrowest command available, read the code under test, and fix the root cause.',
      '3. Never delete, skip or loosen a test to make it pass unless the test is demonstrably wrong; say so if you do.',
      '4. Re-run the full test command and report exactly what passes and what still fails.',
    ].join('\n'),
  },
  {
    name: 'add-tests',
    description: "Add tests for existing code using the project's test framework and style",
    source: 'built-in',
    body: [
      '1. Read the code to test and one existing test file to copy its framework, layout and naming.',
      '2. Cover normal behaviour, edge cases and error paths; keep tests deterministic (no network, clock or randomness without control).',
      '3. Run the new tests and confirm they pass; briefly confirm they would fail if the behaviour broke when practical.',
    ].join('\n'),
  },
];

/** Minimal frontmatter: `---\nname: x\ndescription: y\n---`. */
export function parseSkill(
  raw: string,
  fallbackName: string,
): { name: string; description: string; body: string } {
  let name = fallbackName;
  let description = '';
  let body = raw;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (m) {
    body = m[2] ?? '';
    for (const line of (m[1] ?? '').split(/\r?\n/)) {
      const kv = /^(name|description):\s*(.*)$/.exec(line);
      if (kv?.[1] === 'name') name = (kv[2] ?? '').trim();
      if (kv?.[1] === 'description') description = (kv[2] ?? '').trim();
    }
  }
  return { name, description, body: body.trim() };
}

/** Built-ins plus `.mia/skills/<name>/SKILL.md`. Project skills override built-ins of the same name. */
export async function loadSkills(root: string): Promise<Skill[]> {
  const byName = new Map<string, Skill>(BUILTIN_SKILLS.map((s) => [s.name, s]));
  let dirs: string[] = [];
  try {
    const base = path.join(root, '.mia', 'skills');
    const st = await fs.lstat(base);
    if (st.isDirectory()) {
      const entries = await fs.readdir(base, { withFileTypes: true });
      dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .slice(0, 50);
    }
  } catch {
    /* no project skills */
  }
  for (const dir of dirs) {
    let raw: string | null;
    try {
      raw = await readFileSafe(root, `.mia/skills/${dir}/SKILL.md`, 1_000_000);
    } catch {
      continue;
    }
    if (raw === null) continue;
    const text = raw.length > MAX_SKILL_BYTES ? raw.slice(0, MAX_SKILL_BYTES) : raw;
    const p = parseSkill(text, dir);
    if (!NAME.test(p.name) || p.body === '') continue;
    byName.set(p.name, {
      name: p.name,
      description: p.description || '(no description)',
      body: p.body,
      source: 'project',
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
