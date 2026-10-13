export const REDACTED = '[REDACTED]';

/** Token-shaped secrets with well-known prefixes. */
const TOKEN_PATTERNS: RegExp[] = [
  /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{8,}/g,
  /(?<![A-Za-z0-9])sk-or-[A-Za-z0-9_-]{8,}/g,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9])gsk_[A-Za-z0-9]{16,}/g,
  /(?<![A-Za-z0-9])xai-[A-Za-z0-9]{16,}/g,
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{20,}/g,
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

const BEARER = /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const KEY_VALUE =
  /(\b(?:api[-_]?key|x-api-key|authorization|access[-_]?token|secret|password)["']?\s*[:=]\s*["']?)([^\s"',;]{6,})/gi;

const registered = new Set<string>();

/** Registers an exact secret value so it is masked anywhere it appears in output. */
export function registerSecret(value: string): void {
  if (value.length >= 8) registered.add(value);
}

export function clearRegisteredSecrets(): void {
  registered.clear();
}

/** True when the text contains a token-shaped secret (used to keep secrets out of config files). */
export function containsSecretToken(text: string): boolean {
  return TOKEN_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

/** Masks registered secrets, token-shaped secrets, bearer tokens and key=value credentials. */
export function redact(text: string): string {
  let result = text;
  for (const secret of registered) {
    if (result.includes(secret)) result = result.split(secret).join(REDACTED);
  }
  for (const pattern of TOKEN_PATTERNS) result = result.replace(pattern, REDACTED);
  result = result.replace(BEARER, `$1${REDACTED}`);
  result = result.replace(KEY_VALUE, `$1${REDACTED}`);
  return result;
}
