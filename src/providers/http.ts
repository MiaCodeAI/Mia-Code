import { ProviderError, errorFromException, errorFromResponse } from './errors.js';

/**
 * Tracks one request's cancellation and timeout. The timer measures *inactivity*:
 * call touch() whenever data arrives and it restarts.
 */
export class RequestScope {
  readonly controller = new AbortController();
  timedOut = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly onExternalAbort = (): void => {
    this.controller.abort();
  };

  constructor(
    private readonly timeoutMs: number,
    private readonly external?: AbortSignal,
  ) {
    if (external) {
      if (external.aborted) this.controller.abort();
      else external.addEventListener('abort', this.onExternalAbort, { once: true });
    }
    this.touch();
  }

  get externallyAborted(): boolean {
    return this.external?.aborted === true;
  }

  touch(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.controller.abort();
    }, this.timeoutMs);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.external?.removeEventListener('abort', this.onExternalAbort);
  }

  state(): { timedOut: boolean; aborted: boolean } {
    return { timedOut: this.timedOut, aborted: this.externallyAborted };
  }
}

async function readBodyText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 8000);
  } catch {
    return '';
  }
}

/**
 * Sends a request and returns the response only if it is a success.
 * Redirects are never followed: doing so could forward the API key to another host.
 */
export async function sendRequest(
  scope: RequestScope,
  provider: string,
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: scope.controller.signal,
      redirect: 'manual',
    });
  } catch (error) {
    throw errorFromException(provider, error, scope.state());
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderError({
      provider,
      code: 'invalid_response',
      status: response.status,
      message: `The endpoint answered with a redirect (HTTP ${response.status}). Mia Code does not follow redirects because that could send your API key to a different host.`,
      hint: 'Update the provider base URL to the final address ("mia provider add").',
    });
  }
  if (!response.ok) {
    const text = await readBodyText(response);
    throw errorFromResponse(provider, response.status, text, response.headers);
  }
  return response;
}

export async function readJson(
  scope: RequestScope,
  provider: string,
  response: Response,
): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw errorFromException(provider, error, scope.state());
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError({
      provider,
      code: 'invalid_response',
      message: 'The endpoint did not return JSON. It may not be an API endpoint.',
      hint: 'Check the provider base URL ("mia provider list").',
    });
  }
}
