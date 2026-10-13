export type ExclusionReason = 'secret' | 'dependency' | 'build-output' | 'cache' | 'vcs' | 'binary';

/** Directories that are never listed or read. */
const EXCLUDED_DIRS: Record<string, ExclusionReason> = {
  '.git': 'vcs',
  '.hg': 'vcs',
  '.svn': 'vcs',
  node_modules: 'dependency',
  bower_components: 'dependency',
  vendor: 'dependency',
  '.venv': 'dependency',
  venv: 'dependency',
  __pypackages__: 'dependency',
  '.terraform': 'dependency',
  dist: 'build-output',
  build: 'build-output',
  out: 'build-output',
  target: 'build-output',
  '.next': 'build-output',
  '.nuxt': 'build-output',
  coverage: 'build-output',
  __pycache__: 'cache',
  '.cache': 'cache',
  '.gradle': 'cache',
  '.mypy_cache': 'cache',
  '.pytest_cache': 'cache',
  '.tox': 'cache',
  '.mia': 'cache',
};

const SECRET_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.crt',
  '.cer',
  '.der',
  '.kdbx',
  '.gpg',
]);

const SECRET_NAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.htpasswd',
  '.git-credentials',
  '.dockercfg',
  'credentials',
  'credentials.json',
  'secrets.json',
  'secrets.yml',
  'secrets.yaml',
  'secrets.toml',
]);

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.tiff',
  '.psd',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.jar',
  '.war',
  '.class',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.o',
  '.a',
  '.lib',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.wav',
  '.flac',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.sqlite',
  '.sqlite3',
  '.db',
]);

const ENV_TEMPLATE = /^\.env\.(?:example|sample|template)$/;

export function excludedDirReason(name: string): ExclusionReason | null {
  return EXCLUDED_DIRS[name.toLowerCase()] ?? null;
}

export function excludedFileReason(name: string): ExclusionReason | null {
  const lower = name.toLowerCase();
  if (lower === '.env' || (lower.startsWith('.env.') && !ENV_TEMPLATE.test(lower))) return 'secret';
  if (SECRET_NAMES.has(lower)) return 'secret';
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)/.test(lower)) return 'secret';
  if (/^service[-_]account.*\.json$/.test(lower)) return 'secret';
  if (/^terraform\.tfstate/.test(lower)) return 'secret';
  const dot = lower.lastIndexOf('.');
  const ext = dot > 0 ? lower.slice(dot) : '';
  if (SECRET_EXTENSIONS.has(ext)) return 'secret';
  if (BINARY_EXTENSIONS.has(ext)) return 'binary';
  return null;
}

/** Checks a `/`-separated path relative to the project: every directory segment, then the file name. */
export function excludedPathReason(relativePosixPath: string): ExclusionReason | null {
  const segments = relativePosixPath.split('/').filter((s) => s !== '');
  const file = segments.pop();
  for (const segment of segments) {
    const reason = excludedDirReason(segment);
    if (reason) return reason;
  }
  return file === undefined ? null : excludedFileReason(file);
}
