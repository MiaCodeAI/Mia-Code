import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runAudit, AUDIT_MODES, type AuditMode } from '../audit/engine.js';
import { meetsThreshold, renderReport, type ReportFormat } from '../audit/report.js';
import { CATEGORIES, SEVERITIES, type AuditCategory, type Severity } from '../audit/types.js';
import type { Context } from '../context.js';
import { UsageError, UserError } from '../errors.js';
import { RepoIndex } from '../repo/index.js';
import { buildOverview } from '../repo/overview.js';
import { buildRepoMap, renderRepoMap } from '../repo/map.js';
import { searchText } from '../repo/search.js';
import { flag, parseFlags, str } from './flags.js';

export async function openIndex(ctx: Context): Promise<RepoIndex> {
  const index = new RepoIndex(ctx.cwd, ctx.run, ctx.env);
  await index.refresh();
  return index;
}

/** `mia scan`: repository map and detected project facts. Reads local files only; sends nothing. */
export async function scanCommand(args: string[], ctx: Context): Promise<number> {
  const { values } = parseFlags(
    args,
    { json: { type: 'boolean' }, full: { type: 'boolean' } },
    false,
  );
  const index = await openIndex(ctx);
  if (flag(values, 'json')) {
    const { map } = buildRepoMap(index);
    ctx.print(JSON.stringify(map, null, 2));
    return 0;
  }
  if (flag(values, 'full')) {
    const { text } = await buildOverview(index, ctx.run, ctx.env, { maxPaths: 100_000 });
    ctx.print(text);
    return 0;
  }
  const { map } = buildRepoMap(index);
  for (const line of renderRepoMap(map)) ctx.print(line);
  return 0;
}

/** `mia search <text>`: literal or regex search restricted to files the exclusion policy allows. */
export async function searchCommand(args: string[], ctx: Context): Promise<number> {
  const { values, positionals } = parseFlags(args, {
    regex: { type: 'boolean', short: 'e' },
    'ignore-case': { type: 'boolean', short: 'i' },
    symbol: { type: 'boolean', short: 's' },
    max: { type: 'string' },
  });
  const query = positionals.join(' ').trim();
  if (query === '')
    throw new UsageError(
      'Usage: mia search [--regex] [--ignore-case] [--symbol] [--max <n>] <text>',
    );
  const maxRaw = str(values, 'max');
  const max = maxRaw === undefined ? 50 : Number(maxRaw);
  if (!Number.isInteger(max) || max < 1 || max > 1000)
    throw new UsageError('--max must be an integer from 1 to 1000');
  const index = await openIndex(ctx);

  if (flag(values, 'symbol')) {
    const found = index.findSymbols(query, max);
    for (const s of found) ctx.print(`${s.path}:${s.line}  ${s.kind} ${s.name}`);
    if (found.length === 0)
      ctx.printErr(
        'No matching symbols. Symbol detection is pattern-based and covers common languages only.',
      );
    return found.length > 0 ? 0 : 1;
  }
  const result = await searchText(index.inventory, ctx.run, {
    patterns: [query],
    regex: flag(values, 'regex'),
    ignoreCase: flag(values, 'ignore-case'),
    maxResults: max,
  });
  if (result.error) throw new UserError(`Invalid pattern: ${result.error}`);
  for (const hit of result.hits) ctx.print(`${hit.path}:${hit.line}: ${hit.text}`);
  ctx.printErr(
    ctx.style.dim(
      `${result.hits.length} match(es) using ${result.engine}${result.truncated ? '; more exist (raise --max)' : ''}.`,
    ),
  );
  return result.hits.length > 0 ? 0 : 1;
}

async function realTarget(target: string): Promise<string> {
  let existing = target;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(existing), ...tail);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return target;
      tail.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

function insideProject(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** `mia audit`: read-only static audit. Never modifies project files. */
export async function auditCommand(args: string[], ctx: Context): Promise<number> {
  const { values } = parseFlags(
    args,
    {
      mode: { type: 'string' },
      categories: { type: 'string' },
      format: { type: 'string' },
      output: { type: 'string', short: 'o' },
      'fail-on': { type: 'string' },
    },
    false,
  );
  const mode = (str(values, 'mode') ?? 'standard') as AuditMode;
  if (mode === ('performance' as string)) {
    throw new UserError(
      'Performance audits need profiling and runtime measurements, which this read-only static audit does not do.',
    );
  }
  if (!AUDIT_MODES.includes(mode))
    throw new UsageError(`Unknown mode "${mode}". Modes: ${AUDIT_MODES.join(', ')}.`);
  const format = (str(values, 'format') ?? 'text') as ReportFormat;
  if (!['text', 'json', 'markdown'].includes(format))
    throw new UsageError('--format must be text, json or markdown');
  let categories: AuditCategory[] | undefined;
  const catRaw = str(values, 'categories');
  if (catRaw !== undefined) {
    categories = catRaw
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean) as AuditCategory[];
    const bad = categories.filter((c) => !CATEGORIES.includes(c));
    if (bad.length > 0)
      throw new UsageError(
        `Unknown categories: ${bad.join(', ')}. Available: ${CATEGORIES.join(', ')}.`,
      );
  }
  if (mode === 'custom' && !categories)
    throw new UsageError(`--mode custom needs --categories (${CATEGORIES.join(', ')})`);
  const failOn = str(values, 'fail-on') as Severity | undefined;
  if (failOn !== undefined && !SEVERITIES.includes(failOn))
    throw new UsageError(`--fail-on must be one of ${SEVERITIES.join(', ')}`);

  const index = await openIndex(ctx);
  const outputArg = str(values, 'output');
  let outputPath: string | undefined;
  if (outputArg !== undefined) {
    outputPath = await realTarget(path.resolve(ctx.cwd, outputArg));
    if (insideProject(index.inventory.root, outputPath)) {
      throw new UserError(
        'Refusing to write the report inside the audited project: audits are read-only. Choose a location outside it.',
      );
    }
  }
  const result = await runAudit(index, ctx.run, ctx.env, {
    mode,
    ...(categories ? { categories } : {}),
  });
  const report = renderReport(result, format);
  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${report}\n`, 'utf8');
    ctx.printErr(`Report written to ${outputPath}`);
  } else ctx.print(report);
  return failOn && meetsThreshold(result.findings, failOn) ? 1 : 0;
}
