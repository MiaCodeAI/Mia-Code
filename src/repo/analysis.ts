import { languageOf } from './languages.js';
import type { FileAnalysis, RouteEntry, SymbolEntry, SymbolKind } from './types.js';

/**
 * Pattern-based extraction. This is deliberately NOT a parser: it finds the common declaration
 * shapes line by line, so unusual syntax can be missed and a few false positives are possible.
 * Results are labelled "heuristic" wherever they are shown to users.
 */

interface SymbolRule {
  re: RegExp;
  kind: SymbolKind;
  group?: number;
  /** Only applies to indented (nested) declarations. */
  nested?: boolean;
  /** Only applies at column zero. */
  topLevel?: boolean;
}

const METHOD_NOT: ReadonlySet<string> = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'function',
  'return',
  'else',
  'do',
  'with',
  'constructor',
  'super',
  'new',
  'await',
  'typeof',
  'import',
  'require',
]);

const JS_RULES: SymbolRule[] = [
  {
    re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
    kind: 'function',
  },
  {
    re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    kind: 'class',
  },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
  {
    re: /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/,
    kind: 'type',
  },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum' },
  {
    re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/,
    kind: 'function',
  },
  {
    re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?function\b/,
    kind: 'function',
  },
  {
    re: /^\s+(?:(?:public|private|protected|static|readonly|override|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::\s*[^={;]+)?\{\s*$/,
    kind: 'method',
    nested: true,
  },
];

const PY_RULES: SymbolRule[] = [
  { re: /^(?:async\s+)?def\s+(\w+)/, kind: 'function', topLevel: true },
  { re: /^\s+(?:async\s+)?def\s+(\w+)/, kind: 'method', nested: true },
  { re: /^\s*class\s+(\w+)/, kind: 'class' },
];

const GO_RULES: SymbolRule[] = [
  { re: /^func\s+\([^)]*\)\s*(\w+)/, kind: 'method' },
  { re: /^func\s+(\w+)/, kind: 'function' },
  { re: /^type\s+(\w+)\s+struct\b/, kind: 'struct' },
  { re: /^type\s+(\w+)\s+interface\b/, kind: 'interface' },
];

const RUST_RULES: SymbolRule[] = [
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/, kind: 'function' },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)/, kind: 'struct' },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+(\w+)/, kind: 'enum' },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+(\w+)/, kind: 'trait' },
];

const JVM_RULES: SymbolRule[] = [
  { re: /\b(?:class|record)\s+([A-Z]\w*)/, kind: 'class' },
  { re: /\binterface\s+([A-Z]\w*)/, kind: 'interface' },
  { re: /\benum\s+([A-Z]\w*)/, kind: 'enum' },
  { re: /\bobject\s+([A-Z]\w*)/, kind: 'class' },
  { re: /\bfun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)\s*\(/, kind: 'function' },
  {
    re: /^\s+(?:(?:public|private|protected|static|final|abstract|synchronized|override|async)\s+)+[\w<>[\],.?\s]+?\s+(\w+)\s*\([^;]*$/,
    kind: 'method',
    nested: true,
  },
];

const PHP_RULES: SymbolRule[] = [
  { re: /^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/, kind: 'class' },
  { re: /^\s*interface\s+(\w+)/, kind: 'interface' },
  { re: /^\s*trait\s+(\w+)/, kind: 'trait' },
  {
    re: /^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+&?(\w+)/,
    kind: 'function',
  },
];

const RUBY_RULES: SymbolRule[] = [
  { re: /^\s*class\s+([A-Z]\w*)/, kind: 'class' },
  { re: /^\s*module\s+([A-Z]\w*)/, kind: 'module' },
  { re: /^\s*def\s+(?:self\.)?(\w+[?!]?)/, kind: 'function' },
];

const C_RULES: SymbolRule[] = [
  { re: /^\s*(?:typedef\s+)?(?:class|struct)\s+(\w+)/, kind: 'struct' },
  { re: /^\s*enum\s+(?:class\s+)?(\w+)/, kind: 'enum' },
];

const SWIFT_RULES: SymbolRule[] = [
  {
    re: /^\s*(?:public\s+|private\s+|internal\s+|open\s+|final\s+)*(?:class|struct|enum|protocol|actor)\s+(\w+)/,
    kind: 'class',
  },
  {
    re: /^\s*(?:public\s+|private\s+|internal\s+|open\s+|static\s+|final\s+|override\s+)*func\s+(\w+)/,
    kind: 'function',
  },
];

const DART_RULES: SymbolRule[] = [
  { re: /^\s*(?:abstract\s+)?class\s+(\w+)/, kind: 'class' },
  { re: /^\s*(?:mixin|enum)\s+(\w+)/, kind: 'type' },
];

const SHELL_RULES: SymbolRule[] = [
  { re: /^\s*(?:function\s+)?(\w[\w-]*)\s*\(\)\s*\{/, kind: 'function' },
];

const SQL_RULES: SymbolRule[] = [
  {
    re: /^\s*create\s+(?:or\s+replace\s+)?(?:table|view|function|procedure)\s+(?:if\s+not\s+exists\s+)?([\w."]+)/i,
    kind: 'type',
  },
];

function rulesFor(language: string): SymbolRule[] {
  switch (language) {
    case 'TypeScript':
    case 'JavaScript':
    case 'Vue':
    case 'Svelte':
      return JS_RULES;
    case 'Python':
      return PY_RULES;
    case 'Go':
      return GO_RULES;
    case 'Rust':
      return RUST_RULES;
    case 'Java':
    case 'Kotlin':
    case 'Scala':
    case 'C#':
      return JVM_RULES;
    case 'PHP':
      return PHP_RULES;
    case 'Ruby':
      return RUBY_RULES;
    case 'C':
    case 'C++':
    case 'C/C++ header':
    case 'Objective-C':
      return C_RULES;
    case 'Swift':
      return SWIFT_RULES;
    case 'Dart':
      return DART_RULES;
    case 'Shell':
      return SHELL_RULES;
    case 'SQL':
      return SQL_RULES;
    default:
      return [];
  }
}

function extractSymbols(
  filePath: string,
  language: string,
  lines: readonly string[],
): SymbolEntry[] {
  const rules = rulesFor(language);
  if (rules.length === 0) return [];
  const symbols: SymbolEntry[] = [];
  const isJs = rules === JS_RULES;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.length > 400 || line.trim() === '') continue;
    const trimmed = line.trimStart();
    if (
      trimmed.startsWith('//') ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('/*')
    ) {
      if (!(language === 'Shell' || language === 'Python')) continue;
      if (trimmed.startsWith('#')) continue;
    }
    const indented = /^\s/.test(line);
    for (const rule of rules) {
      if (rule.nested && !indented) continue;
      if (rule.topLevel && indented) continue;
      const match = rule.re.exec(line);
      const name = match?.[rule.group ?? 1];
      if (!name) continue;
      if (rule.kind === 'method' && isJs && METHOD_NOT.has(name)) continue;
      symbols.push({ name, kind: rule.kind, path: filePath, line: i + 1 });
      break;
    }
  }
  return symbols;
}

const JS_IMPORTS: RegExp[] = [
  /\bfrom\s+['"]([^'"\n]+)['"]/g,
  /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /^\s*import\s+['"]([^'"\n]+)['"]/g,
];

function extractImports(language: string, lines: readonly string[]): string[] {
  const found = new Set<string>();
  if (
    language === 'TypeScript' ||
    language === 'JavaScript' ||
    language === 'Vue' ||
    language === 'Svelte'
  ) {
    for (const line of lines) {
      if (line.length > 600) continue;
      for (const re of JS_IMPORTS) {
        re.lastIndex = 0;
        for (const match of line.matchAll(re)) if (match[1]) found.add(match[1]);
      }
    }
  } else if (language === 'Python') {
    for (const line of lines) {
      const from = /^\s*from\s+([.\w]+)\s+import\b/.exec(line);
      if (from?.[1]) {
        found.add(from[1]);
        continue;
      }
      const imp = /^\s*import\s+([\w.,\s]+?)(?:\s+as\s+\w+)?\s*$/.exec(line);
      if (imp?.[1])
        for (const part of imp[1].split(','))
          if (part.trim()) found.add(part.trim().split(/\s+/)[0] as string);
    }
  } else if (language === 'Go') {
    let inBlock = false;
    for (const line of lines) {
      if (/^import\s*\(/.test(line)) inBlock = true;
      else if (inBlock && /^\)/.test(line)) inBlock = false;
      else if (inBlock) {
        const m = /"([^"]+)"/.exec(line);
        if (m?.[1]) found.add(m[1]);
      } else {
        const single = /^import\s+(?:\w+\s+)?"([^"]+)"/.exec(line);
        if (single?.[1]) found.add(single[1]);
      }
    }
  } else if (language === 'Java' || language === 'Kotlin' || language === 'Scala') {
    for (const line of lines) {
      const m = /^import\s+(?:static\s+)?([\w.]+)/.exec(line);
      if (m?.[1]) found.add(m[1]);
    }
  } else if (language === 'Rust') {
    for (const line of lines) {
      const m = /^\s*use\s+([\w:]+)/.exec(line);
      if (m?.[1]) found.add(m[1]);
    }
  }
  return [...found];
}

const ENV_PATTERNS: RegExp[] = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  /process\.env\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
  /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g,
  /os\.environ(?:\.get)?\s*[([]\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /os\.getenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /os\.Getenv\(\s*"([A-Z_][A-Z0-9_]*)"/g,
  /env::var\(\s*"([A-Z_][A-Z0-9_]*)"/g,
  /System\.getenv\(\s*"([A-Z_][A-Z0-9_]*)"/g,
  /\bgetenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /\bENV\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
  /\benv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
];

function extractEnvVars(lines: readonly string[]): string[] {
  const found = new Set<string>();
  for (const line of lines) {
    if (line.length > 600 || !/env|ENV/.test(line)) continue;
    for (const re of ENV_PATTERNS) {
      re.lastIndex = 0;
      for (const match of line.matchAll(re)) if (match[1]) found.add(match[1]);
    }
  }
  return [...found].sort();
}

function extractRoutes(filePath: string, language: string, lines: readonly string[]): RouteEntry[] {
  const routes: RouteEntry[] = [];
  const base = filePath.slice(filePath.lastIndexOf('/') + 1).toLowerCase();
  const push = (method: string, route: string, i: number): void => {
    routes.push({ method: method.toUpperCase(), route, path: filePath, line: i + 1 });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.length > 400) continue;
    let m: RegExpExecArray | null;
    if (language === 'TypeScript' || language === 'JavaScript') {
      m =
        /\b(?:app|router|server|fastify|api|route)\.(get|post|put|patch|delete|all)\(\s*['"`]([^'"`]+)['"`]/.exec(
          line,
        );
      if (m?.[1] && m[2]) push(m[1], m[2], i);
    } else if (language === 'Python') {
      m = /@\w+\.route\(\s*['"]([^'"]+)['"](?:[^)]*methods\s*=\s*\[([^\]]*)\])?/.exec(line);
      if (m?.[1]) {
        push((m[2] ?? 'GET').replace(/['"\s]/g, '') || 'GET', m[1], i);
        continue;
      }
      m = /@\w+\.(get|post|put|patch|delete)\(\s*['"]([^'"]*)['"]/.exec(line);
      if (m?.[1] && m[2] !== undefined) push(m[1], m[2], i);
      else if (base === 'urls.py') {
        m = /\b(?:re_)?path\(\s*r?['"]([^'"]*)['"]/.exec(line);
        if (m?.[1] !== undefined) push('ANY', m[1], i);
      }
    } else if (language === 'Go') {
      m = /\.(HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE)\(\s*"([^"]+)"/.exec(line);
      if (m?.[1] && m[2]) push(/^[A-Z]+$/.test(m[1]) ? m[1] : 'ANY', m[2], i);
    } else if (language === 'Java' || language === 'Kotlin') {
      m = /@(Get|Post|Put|Patch|Delete|Request)Mapping\(\s*(?:value\s*=\s*)?\{?\s*"([^"]+)"/.exec(
        line,
      );
      if (m?.[1] && m[2]) push(m[1] === 'Request' ? 'ANY' : m[1], m[2], i);
    } else if (language === 'PHP') {
      m = /Route::(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/.exec(line);
      if (m?.[1] && m[2]) push(m[1], m[2], i);
    } else if (language === 'Ruby' && base === 'routes.rb') {
      m = /^\s*(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/.exec(line);
      if (m?.[1] && m[2]) push(m[1], m[2], i);
    }
  }
  return routes;
}

/** Extracts symbols, imports, environment-variable names and routes from source text. */
export function analyzeFile(filePath: string, text: string): FileAnalysis {
  const language = languageOf(filePath)?.name ?? '';
  const lines = text.split(/\r?\n/);
  return {
    symbols: extractSymbols(filePath, language, lines),
    imports: extractImports(language, lines),
    envVars: extractEnvVars(lines),
    routes: extractRoutes(filePath, language, lines),
    lineCount: lines.length,
  };
}
