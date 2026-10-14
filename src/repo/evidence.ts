import type { Runner } from '../platform/exec.js';
import { findSecretTokens, redact } from '../security/redact.js';
import type { RepoIndex } from './index.js';
import { buildRepoMap } from './map.js';
import { readTextFile } from './read.js';
import { searchText } from './search.js';
import { isTestFile } from './tests-map.js';

export interface Excerpt {
  path: string;
  startLine: number;
  endLine: number;
  /** Line-numbered, redacted text exactly as sent to the model. */
  text: string;
  reason: string;
}

export interface EvidenceBundle {
  excerpts: Excerpt[];
  keywords: string[];
  chars: number;
  budgetChars: number;
  skipped: { path: string; reason: string }[];
  searchEngine: string;
}

const STOPWORDS = new Set(
  (
    'a an and are as at be but by can could do does for from had has have how i if in into is it its just like me my no not of on or ' +
    'our should so some than that the their them then there these they this to up us was we were what when where which who why will with would you your ' +
    'about above after again all also any because been before being below between both during each few further here more most other over same such ' +
    'too under until very explain describe tell show find fix please code project file files function functions class classes repo repository ' +
    'work works working use used using need want make get give look check review improve improvement improvements issue issues problem problems ' +
    'does doing done thing things way ways part parts main overall detail details long short'
  ).split(/\s+/),
);

const FILE_CAP_LINES = 130;
const WINDOW_BEFORE = 12;
const WINDOW_AFTER = 28;

export interface Keyword {
  text: string;
  /** Identifier-looking words (camelCase, snake_case, containing digits, file names) count more. */
  weight: number;
}

export function extractKeywords(question: string): Keyword[] {
  const found = new Map<string, number>();
  const add = (text: string, weight: number): void => {
    const key = text.toLowerCase();
    if (key.length < 3 || STOPWORDS.has(key)) return;
    found.set(key, Math.max(found.get(key) ?? 0, weight));
  };
  for (const m of question.matchAll(/`([^`\n]{2,80})`|"([^"\n]{2,80})"|'([^'\n]{2,80})'/g)) {
    const phrase = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (phrase !== '') add(phrase, 5);
  }
  for (const m of question.matchAll(/[\w@./\\-]+\.[A-Za-z0-9]{1,8}\b/g))
    add(m[0].replace(/\\/g, '/'), 5);
  for (const m of question.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) {
    const word = m[0];
    const identifierLike =
      /[a-z][A-Z]/.test(word) ||
      word.includes('_') ||
      /\d/.test(word) ||
      /^[A-Z][a-z]+[A-Z]/.test(word);
    add(word, identifierLike ? 4 : 1);
  }
  return [...found.entries()]
    .map(([text, weight]) => ({ text, weight }))
    .sort((a, b) => b.weight - a.weight || b.text.length - a.text.length)
    .slice(0, 12);
}

interface Candidate {
  path: string;
  score: number;
  lines: Set<number>;
  reasons: string[];
  /** Include the start of the file even without matches (entry points, README). */
  baseline: boolean;
}

function mergeWindows(lines: number[], total: number): { start: number; end: number }[] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const windows: { start: number; end: number }[] = [];
  for (const line of sorted) {
    const start = Math.max(1, line - WINDOW_BEFORE);
    const end = Math.min(total, line + WINDOW_AFTER);
    const last = windows.at(-1);
    if (last && start <= last.end + 3) last.end = Math.max(last.end, end);
    else windows.push({ start, end });
  }
  return windows;
}

function numbered(lines: readonly string[], start: number, end: number): string {
  const width = String(end).length;
  const out: string[] = [];
  for (let n = start; n <= end; n++) {
    const raw = lines[n - 1] ?? '';
    out.push(`${String(n).padStart(width)}| ${raw.length > 400 ? `${raw.slice(0, 400)}…` : raw}`);
  }
  return redact(out.join('\n'));
}

/**
 * Chooses the file excerpts most relevant to a question: explicit paths, symbol matches, text
 * matches, then central modules and entry points, within a character budget. Every excerpt is read
 * through the safe reader (exclusion policy, no symlinks), redacted, and line-numbered so the model
 * can cite `path:line` and the citation can be verified afterwards.
 */
export async function gatherEvidence(
  question: string,
  index: RepoIndex,
  run: Runner,
  options: { budgetChars: number; maxFiles?: number; previousQuestion?: string },
): Promise<EvidenceBundle> {
  const { inventory } = index;
  const maxFiles = options.maxFiles ?? 8;
  let keywords = extractKeywords(question);
  if (
    keywords.filter((k) => k.weight >= 4).length === 0 &&
    keywords.length < 2 &&
    options.previousQuestion
  ) {
    const seen = new Set(keywords.map((k) => k.text));
    keywords = [
      ...keywords,
      ...extractKeywords(options.previousQuestion).filter((k) => !seen.has(k.text)),
    ].slice(0, 12);
  }

  const candidates = new Map<string, Candidate>();
  const candidate = (p: string): Candidate => {
    let c = candidates.get(p);
    if (!c) {
      c = { path: p, score: 0, lines: new Set(), reasons: [], baseline: false };
      candidates.set(p, c);
    }
    return c;
  };
  const note = (c: Candidate, reason: string): void => {
    if (!c.reasons.includes(reason) && c.reasons.length < 4) c.reasons.push(reason);
  };

  const allPaths = inventory.files.map((f) => f.path);
  for (const kw of keywords) {
    const lower = kw.text.toLowerCase();
    if (/[./]/.test(kw.text) || kw.weight >= 5) {
      const matches = allPaths.filter(
        (p) => p.toLowerCase() === lower || p.toLowerCase().endsWith(`/${lower}`),
      );
      for (const p of matches.slice(0, 3)) {
        const c = candidate(p);
        c.score += 100;
        c.baseline = true;
        note(c, 'named in the question');
      }
    }
    for (const p of allPaths) {
      const base = p.slice(p.lastIndexOf('/') + 1).toLowerCase();
      if (kw.text.length >= 4 && (base === lower || base.replace(/\.[^.]+$/, '') === lower)) {
        const c = candidate(p);
        c.score += 8;
        note(c, 'file name matches');
      } else if (kw.text.length >= 4 && p.toLowerCase().split('/').slice(0, -1).includes(lower)) {
        const c = candidate(p);
        c.score += 2;
        note(c, 'folder name matches');
      }
    }
  }

  for (const kw of keywords) {
    if (kw.text.length < 3) continue;
    for (const s of index.findSymbols(kw.text, 12)) {
      const exact = s.name.toLowerCase() === kw.text;
      if (!exact && (kw.text.length < 5 || kw.weight < 2)) continue;
      const c = candidate(s.path);
      c.score += (exact ? 10 : 2) * Math.min(kw.weight, 4);
      c.lines.add(s.line);
      note(c, `${s.kind} ${s.name}`);
    }
  }

  let searchEngine = 'none';
  const searchable = keywords.filter((k) => k.text.length >= 3);
  if (searchable.length > 0) {
    const result = await searchText(inventory, run, {
      patterns: searchable.map((k) => k.text),
      ignoreCase: true,
      maxResults: 400,
      maxPerFile: 12,
    });
    searchEngine = result.engine;
    const perFile = new Map<string, number>();
    const filesPerKeyword = new Map<number, Set<string>>();
    for (const hit of result.hits)
      for (const m of hit.matched) {
        const set = filesPerKeyword.get(m) ?? new Set<string>();
        set.add(hit.path);
        filesPerKeyword.set(m, set);
      }
    for (const hit of result.hits) {
      const n = perFile.get(hit.path) ?? 0;
      if (n >= 8) continue;
      perFile.set(hit.path, n + 1);
      const c = candidate(hit.path);
      let weight = 0;
      for (const m of hit.matched) {
        const spread = filesPerKeyword.get(m)?.size ?? 1;
        weight = Math.max(weight, (searchable[m]?.weight ?? 1) / (1 + Math.log2(spread)));
      }
      c.score += weight;
      c.lines.add(hit.line);
      const first = hit.matched[0];
      if (first !== undefined && searchable[first]) note(c, `mentions "${searchable[first].text}"`);
    }
  }

  const { map, graph } = buildRepoMap(index);
  const asksAboutTests = /\btests?\b|\bspec\b/i.test(question);
  for (const [p, c] of candidates) {
    c.score += Math.log2((graph.importedBy.get(p) ?? 0) + 1);
    if (!asksAboutTests && isTestFile(p)) c.score *= 0.4;
  }

  const meaningful = [...candidates.values()].filter((c) => c.score >= 2);
  if (meaningful.length === 0) {
    const baseline: { path: string; reason: string }[] = [];
    const readme = allPaths.find((p) => /^readme(\.[a-z]+)?$/i.test(p));
    if (readme) baseline.push({ path: readme, reason: 'project README' });
    for (const p of map.profile.entryPoints.slice(0, 3))
      baseline.push({ path: p, reason: 'entry point' });
    for (const m of map.keyModules.slice(0, 3))
      baseline.push({ path: m.path, reason: `imported by ${m.importedBy} files` });
    for (const p of map.profile.manifests.slice(0, 1))
      baseline.push({ path: p, reason: 'manifest' });
    for (const b of baseline) {
      const c = candidate(b.path);
      c.baseline = true;
      c.score += 1;
      note(c, b.reason);
    }
  }

  const ranked = [...candidates.values()]
    .filter((c) => c.score >= 1)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, maxFiles);

  const excerpts: Excerpt[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let chars = 0;
  for (const c of ranked) {
    if (chars >= options.budgetChars) {
      skipped.push({ path: c.path, reason: 'evidence budget reached' });
      continue;
    }
    let file;
    try {
      file = await readTextFile(inventory.root, c.path, { maxBytes: 400_000 });
    } catch (error) {
      skipped.push({ path: c.path, reason: (error as Error).message });
      continue;
    }
    if (findSecretTokens(file.text).some((m) => m.kind === 'private-key')) {
      skipped.push({ path: c.path, reason: 'contains a private key' });
      continue;
    }
    const total = file.lines.length;
    let windows: { start: number; end: number }[];
    if (c.lines.size > 0) windows = mergeWindows([...c.lines], total);
    else if (total <= FILE_CAP_LINES && file.text.length <= 7000)
      windows = [{ start: 1, end: total }];
    else windows = [{ start: 1, end: Math.min(total, 70) }];
    if (
      windows.length === 1 &&
      windows[0] &&
      windows[0].end - windows[0].start + 1 > FILE_CAP_LINES
    ) {
      windows[0].end = windows[0].start + FILE_CAP_LINES - 1;
    }
    for (const w of windows.slice(0, 4)) {
      const remaining = options.budgetChars - chars;
      if (remaining < 400) break;
      let end = w.end;
      let text = numbered(file.lines, w.start, end);
      while (text.length > remaining && end > w.start + 5) {
        end -= 5;
        text = numbered(file.lines, w.start, end);
      }
      if (text.length > remaining) break;
      excerpts.push({
        path: c.path,
        startLine: w.start,
        endLine: end,
        text,
        reason: c.reasons.join('; ') || 'relevant',
      });
      chars += text.length;
    }
  }

  return {
    excerpts,
    keywords: keywords.map((k) => k.text),
    chars,
    budgetChars: options.budgetChars,
    skipped,
    searchEngine,
  };
}

/** XML-style block placed in the system prompt. The model is told to treat it as untrusted data. */
export function renderEvidence(bundle: EvidenceBundle): string {
  if (bundle.excerpts.length === 0) return '';
  const parts = bundle.excerpts.map(
    (e) =>
      `<excerpt path="${e.path}" lines="${e.startLine}-${e.endLine}" reason="${e.reason.replace(/"/g, "'")}">\n${e.text}\n</excerpt>`,
  );
  return `<evidence>\n${parts.join('\n')}\n</evidence>`;
}

export function evidenceFiles(bundle: EvidenceBundle): string[] {
  return [...new Set(bundle.excerpts.map((e) => e.path))];
}
