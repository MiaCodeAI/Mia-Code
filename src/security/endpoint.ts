export class EndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EndpointError';
  }
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    host === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * Validates a provider base URL and returns it without a trailing slash.
 * API keys are only ever sent to URLs that pass this check:
 * https is required, except plain http to a loopback address (local model servers).
 */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new EndpointError(
      'The base URL is not a valid URL (example: https://api.example.com/v1).',
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new EndpointError('The base URL must not contain embedded credentials.');
  }
  const secure = url.protocol === 'https:';
  const localPlain = url.protocol === 'http:' && isLoopbackHost(url.hostname);
  if (!secure && !localPlain) {
    throw new EndpointError(
      'The base URL must use https:// (plain http:// is only allowed for localhost).',
    );
  }
  if (url.search !== '' || url.hash !== '') {
    throw new EndpointError('The base URL must not contain a query string or fragment.');
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

export function hostOf(baseUrl: string): string {
  return new URL(baseUrl).host;
}
