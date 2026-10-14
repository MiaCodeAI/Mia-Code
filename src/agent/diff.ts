/** Minimal unified diff (line based). Good enough to review edits; not a replacement for `git diff`. */

export interface DiffStats {
  added: number;
  removed: number;
}

type Op = { kind: ' ' | '+' | '-'; text: string };

function ops(a: string[], b: string[]): Op[] | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n * m > 4_000_000) return null;
  // Longest common subsequence table over the changed middle only.
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        midA[i] === midB[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  const out: Op[] = a.slice(0, start).map((text) => ({ kind: ' ', text }));
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      out.push({ kind: ' ', text: midA[i] ?? '' });
      i++;
      j++;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      out.push({ kind: '-', text: midA[i] ?? '' });
      i++;
    } else {
      out.push({ kind: '+', text: midB[j] ?? '' });
      j++;
    }
  }
  while (i < n) out.push({ kind: '-', text: midA[i++] ?? '' });
  while (j < m) out.push({ kind: '+', text: midB[j++] ?? '' });
  for (const text of a.slice(endA)) out.push({ kind: ' ', text });
  return out;
}

const splitLines = (text: string): string[] =>
  text === '' ? [] : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');

export function diffStats(before: string, after: string): DiffStats {
  const list = ops(splitLines(before), splitLines(after));
  if (!list) return { added: splitLines(after).length, removed: splitLines(before).length };
  return {
    added: list.filter((o) => o.kind === '+').length,
    removed: list.filter((o) => o.kind === '-').length,
  };
}

/** Unified diff with `context` lines around each change. Empty string when nothing changed. */
export function unifiedDiff(
  path: string,
  before: string | null,
  after: string | null,
  context = 3,
): string {
  const a = splitLines(before ?? '');
  const b = splitLines(after ?? '');
  const list = ops(a, b);
  const header = [
    `--- ${before === null ? '/dev/null' : `a/${path}`}`,
    `+++ ${after === null ? '/dev/null' : `b/${path}`}`,
  ];
  if (!list) return [...header, '@@ file too large to diff line by line @@'].join('\n');
  if (!list.some((o) => o.kind !== ' ')) return '';

  const keep = new Array<boolean>(list.length).fill(false);
  list.forEach((o, idx) => {
    if (o.kind === ' ') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(list.length - 1, idx + context); k++)
      keep[k] = true;
  });
  const out = [...header];
  let aLine = 1;
  let bLine = 1;
  let idx = 0;
  while (idx < list.length) {
    if (!keep[idx]) {
      const o = list[idx]!;
      if (o.kind !== '+') aLine++;
      if (o.kind !== '-') bLine++;
      idx++;
      continue;
    }
    const startA = aLine;
    const startB = bLine;
    const body: string[] = [];
    let countA = 0;
    let countB = 0;
    while (idx < list.length && keep[idx]) {
      const o = list[idx]!;
      body.push(`${o.kind}${o.text}`);
      if (o.kind !== '+') {
        aLine++;
        countA++;
      }
      if (o.kind !== '-') {
        bLine++;
        countB++;
      }
      idx++;
    }
    out.push(`@@ -${startA},${countA} +${startB},${countB} @@`, ...body);
  }
  return out.join('\n');
}

/** Colours diff lines (when the styler is enabled) for terminal review. */
export function colorizeDiff(
  diff: string,
  style: {
    green(s: string): string;
    red(s: string): string;
    cyan(s: string): string;
    dim(s: string): string;
  },
): string {
  return diff
    .split('\n')
    .map((l) =>
      l.startsWith('+++') || l.startsWith('---')
        ? style.dim(l)
        : l.startsWith('@@')
          ? style.cyan(l)
          : l.startsWith('+')
            ? style.green(l)
            : l.startsWith('-')
              ? style.red(l)
              : l,
    )
    .join('\n');
}
