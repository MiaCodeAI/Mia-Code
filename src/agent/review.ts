import { isCodeFile } from '../repo/languages.js';

export interface ReviewNote {
  kind: 'unrelated-edit' | 'missing-tests' | 'weakened-test' | 'leftover' | 'risky-pattern';
  path: string;
  message: string;
}

const TEST_PATH =
  /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py|rs)$|(^|\/)test_[^/]+\.py$/i;
export const isTestPath = (p: string): boolean => TEST_PATH.test(p);

interface Line {
  sign: '+' | '-';
  text: string;
}
function changedLines(diff: string): Line[] {
  const out: Line[] = [];
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('+')) out.push({ sign: '+', text: raw.slice(1) });
    else if (raw.startsWith('-')) out.push({ sign: '-', text: raw.slice(1) });
  }
  return out;
}

const ASSERTION =
  /\b(assert\w*|expect\s*\(|should\.|self\.assert\w*|t\.(Error|Fatal)\w*|require\.\w+)/;
const LEFTOVER: Array<[RegExp, string]> = [
  [/\b(TODO|FIXME|XXX)\b/, 'adds a TODO/FIXME'],
  [/\bdebugger\b/, 'adds a debugger statement'],
  [/\bconsole\.(log|debug)\(/, 'adds console logging'],
  [/\bprint\(\s*['"]?(debug|here|xxx)/i, 'adds a debug print'],
  [/\bdbg!\(/, 'adds dbg!()'],
];
const RISKY: Array<[RegExp, string]> = [
  [/catch\s*(\([^)]*\))?\s*\{\s*\}/, 'adds an empty catch block that swallows errors'],
  [/except\s*(\w+)?\s*:\s*pass\b/, 'adds an except-pass that swallows errors'],
  [
    /@ts-ignore|@ts-nocheck|eslint-disable|# type: ignore|# noqa|#\[allow\(/,
    'adds a lint/type suppression',
  ],
  [/\beval\s*\(|\bexec\s*\(\s*(f?['"`]|\w+\s*\+)/, 'adds eval/exec of a dynamic string'],
  [
    /verify\s*=\s*False|rejectUnauthorized\s*:\s*false|InsecureSkipVerify\s*:\s*true/,
    'disables TLS verification',
  ],
];
const SKIP =
  /\b(it|test|describe)\.(skip|only)\(|\bxit\(|\bxdescribe\(|@pytest\.mark\.skip|@Ignore\b|t\.Skip\(/;

/**
 * Pattern-based review of what changed. These are prompts for a human look, not findings of fact:
 * it cannot judge whether logic is correct.
 */
export function reviewChanges(input: {
  changed: readonly string[];
  diffs: ReadonlyMap<string, string>;
  plannedFiles: readonly string[];
}): ReviewNote[] {
  const notes: ReviewNote[] = [];
  const planned = new Set(input.plannedFiles);
  if (planned.size > 0)
    for (const p of input.changed)
      if (!planned.has(p))
        notes.push({
          kind: 'unrelated-edit',
          path: p,
          message: "not in the approved plan's file list",
        });

  const sources = input.changed.filter((p) => isCodeFile(p) && !isTestPath(p));
  const tests = input.changed.filter(isTestPath);
  if (sources.length > 0 && tests.length === 0)
    notes.push({
      kind: 'missing-tests',
      path: sources.slice(0, 3).join(', '),
      message: 'source files changed but no test file changed',
    });

  for (const [p, diff] of input.diffs) {
    const lines = changedLines(diff);
    const added = lines.filter((l) => l.sign === '+');
    if (isTestPath(p)) {
      const removedAsserts = lines.filter((l) => l.sign === '-' && ASSERTION.test(l.text)).length;
      const addedAsserts = added.filter((l) => ASSERTION.test(l.text)).length;
      if (removedAsserts > addedAsserts)
        notes.push({
          kind: 'weakened-test',
          path: p,
          message: `removes ${removedAsserts} assertion line(s) and adds ${addedAsserts}`,
        });
      if (added.some((l) => SKIP.test(l.text)))
        notes.push({
          kind: 'weakened-test',
          path: p,
          message: 'skips or focuses a test (.skip/.only/@skip)',
        });
    }
    for (const [re, msg] of LEFTOVER)
      if (added.some((l) => re.test(l.text)))
        notes.push({ kind: 'leftover', path: p, message: msg });
    for (const [re, msg] of RISKY)
      if (added.some((l) => re.test(l.text)))
        notes.push({ kind: 'risky-pattern', path: p, message: msg });
  }
  return notes;
}
