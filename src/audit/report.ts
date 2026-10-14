import { redact } from '../security/redact.js';
import { SEVERITIES, type AuditResult, type Finding, type Severity } from './types.js';

export type ReportFormat = 'text' | 'json' | 'markdown';

export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

export function meetsThreshold(findings: readonly Finding[], threshold: Severity): boolean {
  const limit = SEVERITIES.indexOf(threshold);
  return findings.some((f) => SEVERITIES.indexOf(f.severity) <= limit);
}

function where(f: Finding): string {
  return f.path === '' ? '(project)' : f.lines ? `${f.path}:${f.lines}` : f.path;
}

function summaryLine(result: AuditResult): string {
  const c = countBySeverity(result.findings);
  return SEVERITIES.map((s) => `${c[s]} ${s}`).join(', ');
}

function renderText(result: AuditResult): string {
  const out: string[] = [];
  out.push(`Mia Code audit (${result.mode}) — read-only static analysis`);
  out.push(`Findings: ${result.findings.length} (${summaryLine(result)})`);
  out.push(
    `Scanned ${result.stats.filesScanned} files in ${result.stats.durationMs} ms; categories: ${result.categoriesChecked.join(', ')}`,
  );
  if (result.stats.truncated) out.push('Note: results or the file list were truncated.');
  if (result.stats.suppressed > 0)
    out.push(`${result.stats.suppressed} line(s) suppressed with mia-audit-ignore.`);
  for (const f of result.findings) {
    out.push(
      '',
      `[${f.severity.toUpperCase()}] ${f.id} ${f.title}`,
      `  Where:      ${where(f)}`,
      `  Confidence: ${f.confidence}${f.verified ? ' (verified fact)' : ' (pattern match, not verified)'}`,
    );
    out.push(
      `  Evidence:   ${f.evidence}`,
      `  Why:        ${f.explanation}`,
      `  Applies if: ${f.conditions}`,
      `  Fix:        ${f.recommendation}`,
      `  Test:       ${f.tests}`,
      `  Checked:    ${f.verification}`,
    );
  }
  if (result.findings.length === 0)
    out.push(
      '',
      'No findings from the checks that ran. That does not mean the project is free of problems.',
    );
  out.push('', 'Not assessed by this audit:');
  for (const n of result.notAssessed) out.push(`  - ${n}`);
  return out.join('\n');
}

function renderMarkdown(result: AuditResult): string {
  const out: string[] = [
    `# Mia Code audit (${result.mode})`,
    '',
    'Read-only static analysis. Findings are pattern-based; each states whether it was verified.',
    '',
  ];
  out.push(
    `- **Findings:** ${result.findings.length} (${summaryLine(result)})`,
    `- **Files scanned:** ${result.stats.filesScanned}`,
    `- **Categories:** ${result.categoriesChecked.join(', ')}`,
  );
  if (result.stats.truncated) out.push('- **Note:** results or the file list were truncated.');
  for (const f of result.findings) {
    out.push(
      '',
      `## ${f.id} — ${f.title}`,
      '',
      `- **Severity:** ${f.severity}`,
      `- **Confidence:** ${f.confidence} (${f.verified ? 'verified fact' : 'pattern match'})`,
      `- **Where:** \`${where(f)}\``,
    );
    out.push(
      `- **Evidence:** \`${f.evidence.replace(/`/g, "'")}\``,
      `- **Why it matters:** ${f.explanation}`,
      `- **Applies if:** ${f.conditions}`,
      `- **Recommendation:** ${f.recommendation}`,
      `- **Tests:** ${f.tests}`,
      `- **How checked:** ${f.verification}`,
    );
  }
  if (result.findings.length === 0) out.push('', 'No findings from the checks that ran.');
  out.push('', '## Not assessed', '', ...result.notAssessed.map((n) => `- ${n}`));
  return out.join('\n');
}

/** Renders a report. Output is passed through secret redaction as a last line of defence. */
export function renderReport(result: AuditResult, format: ReportFormat): string {
  const body =
    format === 'json'
      ? JSON.stringify({ ...result, summary: countBySeverity(result.findings) }, null, 2)
      : format === 'markdown'
        ? renderMarkdown(result)
        : renderText(result);
  return redact(body);
}
