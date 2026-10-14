import type { EvidenceBundle } from './evidence.js';
import type { Inventory } from './types.js';

export interface Citation {
  path: string;
  start: number;
  end: number;
}

export interface Unverified {
  citation: Citation;
  reason: string;
}

export interface CitationReport {
  verified: Citation[];
  unverified: Unverified[];
}

const CITATION =
  /(?<![\w/.-])((?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z0-9]{1,8}):(\d+)(?:\s*[-–]\s*(\d+))?/g;

/** Finds `path:line` and `path:start-end` references in a model answer. */
export function extractCitations(answer: string): Citation[] {
  const found: Citation[] = [];
  const seen = new Set<string>();
  for (const m of answer.replace(/`/g, '').matchAll(CITATION)) {
    const path = (m[1] ?? '').replace(/^\.\//, '');
    const start = Number(m[2]);
    const end = m[3] ? Number(m[3]) : start;
    if (!path || !Number.isFinite(start) || start < 1) continue;
    const key = `${path}:${start}-${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ path, start, end: Math.max(start, end) });
  }
  return found;
}

/**
 * Checks each citation against what the model was actually shown. A citation is verified only when
 * its file exists and its lines fall inside an excerpt that was sent. This cannot prove the model's
 * claim about those lines is correct, but it does catch invented files and line numbers.
 */
export function verifyCitations(
  answer: string,
  bundle: EvidenceBundle,
  inventory: Inventory,
): CitationReport {
  const report: CitationReport = { verified: [], unverified: [] };
  for (const citation of extractCitations(answer)) {
    if (!inventory.byPath.has(citation.path)) {
      report.unverified.push({
        citation,
        reason: 'no such file in the project (or it is excluded)',
      });
      continue;
    }
    const covering = bundle.excerpts.filter((e) => e.path === citation.path);
    if (covering.length === 0) {
      report.unverified.push({ citation, reason: 'file exists but was not shown to the model' });
      continue;
    }
    const covered = covering.some(
      (e) => citation.start >= e.startLine && citation.end <= e.endLine,
    );
    if (covered) report.verified.push(citation);
    else
      report.unverified.push({
        citation,
        reason: 'lines were not in the excerpts shown to the model',
      });
  }
  return report;
}

export function formatCitation(c: Citation): string {
  return c.end === c.start ? `${c.path}:${c.start}` : `${c.path}:${c.start}-${c.end}`;
}

/** One-line summary for the terminal. Returns null when the answer cites nothing. */
export function summarizeCitations(report: CitationReport): string | null {
  const total = report.verified.length + report.unverified.length;
  if (total === 0) return null;
  let line = `Citations: ${report.verified.length} of ${total} verified against the excerpts sent`;
  if (report.unverified.length > 0) {
    line +=
      '. Unverified: ' +
      report.unverified
        .slice(0, 5)
        .map((u) => `${formatCitation(u.citation)} (${u.reason})`)
        .join('; ');
    if (report.unverified.length > 5) line += `; … ${report.unverified.length - 5} more`;
  }
  return line;
}
