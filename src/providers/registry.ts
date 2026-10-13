import type { MaxTokensParam, ProviderConfig, ProviderKind } from '../config/schema.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatibleProvider } from './openai.js';
import type { RetryPolicy } from './retry.js';
import type { Provider } from './types.js';

export interface ProviderPreset {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  /** Official documentation page where the user obtains an API key. */
  docsUrl: string;
  /** The provider's conventional environment variable for its API key. */
  envVar: string;
  maxTokensParam?: MaxTokensParam;
}

/**
 * Starting points only. These URLs were written from provider documentation but have not been
 * exercised against the live services in this build; see docs/providers.md. Any other
 * OpenAI-compatible service can be added with a custom base URL.
 */
export const PRESETS: readonly ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    docsUrl: 'https://platform.openai.com/docs/api-reference',
    envVar: 'OPENAI_API_KEY',
    maxTokensParam: 'max_completion_tokens',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    docsUrl: 'https://docs.claude.com/en/api/overview',
    envVar: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    docsUrl: 'https://openrouter.ai/docs',
    envVar: 'OPENROUTER_API_KEY',
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    docsUrl: 'https://console.groq.com/docs',
    envVar: 'GROQ_API_KEY',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    docsUrl: 'https://api-docs.deepseek.com',
    envVar: 'DEEPSEEK_API_KEY',
  },
];

export function findPreset(id: string | undefined): ProviderPreset | undefined {
  return id === undefined ? undefined : PRESETS.find((p) => p.id === id);
}

export function presetToConfig(preset: ProviderPreset): ProviderConfig {
  const config: ProviderConfig = { kind: preset.kind, baseUrl: preset.baseUrl, preset: preset.id };
  if (preset.maxTokensParam) config.maxTokensParam = preset.maxTokensParam;
  return config;
}

export interface CreateProviderOptions {
  retry: RetryPolicy;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export function createProvider(
  name: string,
  config: ProviderConfig,
  apiKey: string | undefined,
  options: CreateProviderOptions,
): Provider {
  const timeoutMs = config.timeoutMs ?? options.timeoutMs;
  const common = { name, baseUrl: config.baseUrl, timeoutMs, retry: options.retry };
  const fetchPart = options.fetchImpl ? { fetchImpl: options.fetchImpl } : {};

  if (config.kind === 'anthropic') {
    if (!apiKey) throw new Error('The Anthropic adapter requires an API key.');
    return new AnthropicProvider({ ...common, ...fetchPart, apiKey });
  }
  return new OpenAICompatibleProvider({
    ...common,
    ...fetchPart,
    ...(apiKey ? { apiKey } : {}),
    ...(config.maxTokensParam ? { maxTokensParam: config.maxTokensParam } : {}),
  });
}
