import { ProviderError } from './errors.js';
import type { Provider } from './types.js';

/** True when the provider rejected the request because the model or endpoint does not accept tools. */
export function isToolsUnsupported(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  if (!(error.code === 'bad_request' || error.status === 404 || error.status === 422)) return false;
  const m = error.message;
  // The model supports tools but produced a bad call: not an "unsupported" case.
  if (
    /tool_use_failed|failed to (call|generate|parse)|invalid (tool|function) (call|arguments)/i.test(
      m,
    )
  )
    return false;
  const mentionsTools =
    /\b(tools?|tool[ _-]?calling|tool_choice|function[ _-]?calling|functions)\b/i.test(m);
  const saysNo =
    /not supported|unsupported|does not support|doesn'?t support|not available|not enabled|unrecognized|unknown (field|parameter|argument)|extra inputs|cannot use|can'?t use|no endpoints found/i.test(
      m,
    );
  return mentionsTools && saysNo;
}

export type ToolSupport = 'supported' | 'unclear' | 'unsupported' | 'unknown';

export interface ToolProbe {
  status: ToolSupport;
  detail: string;
}

/**
 * Asks the model to call a harmless dummy tool. This is a measurement, not a guess from the name:
 * "supported" means the model actually emitted a tool call; "unsupported" means the provider rejected
 * the `tools` parameter; "unclear" means tools were accepted but the model answered in text.
 */
export async function probeToolCalling(
  provider: Provider,
  model: string,
  signal?: AbortSignal,
): Promise<ToolProbe> {
  try {
    let called = false;
    for await (const event of provider.streamChat({
      model,
      maxOutputTokens: 128,
      messages: [
        {
          role: 'user',
          content: 'Call the function "ping" with {"value": "hello"}. Do not answer in text.',
        },
      ],
      tools: [
        {
          name: 'ping',
          description: 'Returns pong. Call this to answer.',
          parameters: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
        },
      ],
      ...(signal ? { signal } : {}),
    })) {
      if (event.type === 'tool_call') called = true;
    }
    return called
      ? { status: 'supported', detail: 'the model called a test tool correctly' }
      : {
          status: 'unclear',
          detail:
            'tools were accepted, but the model answered in text instead of calling the test tool',
        };
  } catch (error) {
    if (isToolsUnsupported(error))
      return { status: 'unsupported', detail: 'the provider rejected tool calling for this model' };
    return {
      status: 'unknown',
      detail: `could not test (${error instanceof ProviderError ? error.code.replace('_', ' ') : 'error'})`,
    };
  }
}
