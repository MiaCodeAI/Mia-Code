import type { CapabilityOverride, MiaConfig } from '../config/schema.js';
import type { ModelInfo } from './types.js';

export type CapabilitySource = 'config' | 'discovery';

export interface ResolvedCapabilities {
  contextWindow?: number;
  maxOutputTokens?: number;
  streaming?: boolean;
  tools?: boolean;
  structuredOutput?: boolean;
  imageInput?: boolean;
  reasoning?: boolean;
  notes?: string;
  sources: Partial<Record<keyof CapabilityOverride, CapabilitySource>>;
}

const FIELDS = [
  'contextWindow',
  'maxOutputTokens',
  'streaming',
  'tools',
  'structuredOutput',
  'imageInput',
  'reasoning',
  'notes',
] as const;

/**
 * Resolves what is known about a model. Nothing is inferred from the model's name:
 * a capability is either stated by the user's config, reported by the provider's model
 * listing, or unknown. Config entries are keyed `<provider>/<model>`, with `<provider>/*`
 * as a provider-wide default.
 */
export function resolveCapabilities(
  config: MiaConfig,
  providerName: string,
  model: string,
  discovered?: ModelInfo,
): ResolvedCapabilities {
  const result: ResolvedCapabilities = { sources: {} };
  if (discovered?.contextWindow !== undefined) {
    result.contextWindow = discovered.contextWindow;
    result.sources.contextWindow = 'discovery';
  }
  const layers = [
    config.capabilities[`${providerName}/*`],
    config.capabilities[`${providerName}/${model}`],
  ];
  for (const layer of layers) {
    if (!layer) continue;
    for (const field of FIELDS) {
      const value = layer[field];
      if (value === undefined) continue;
      (result as unknown as Record<string, unknown>)[field] = value;
      result.sources[field] = 'config';
    }
  }
  return result;
}

function show(value: boolean | number | undefined, source: CapabilitySource | undefined): string {
  if (value === undefined) return 'unknown';
  return `${String(value)} (${source === 'discovery' ? 'reported by provider' : 'from your config'})`;
}

/** Human-readable lines for `mia model` output and the setup wizard. */
export function describeCapabilities(caps: ResolvedCapabilities): string[] {
  return [
    `context window:    ${show(caps.contextWindow, caps.sources.contextWindow)}`,
    `max output tokens: ${show(caps.maxOutputTokens, caps.sources.maxOutputTokens)}`,
    `streaming:         ${show(caps.streaming, caps.sources.streaming)}`,
    `tool calling:      ${show(caps.tools, caps.sources.tools)}`,
    `structured output: ${show(caps.structuredOutput, caps.sources.structuredOutput)}`,
    `image input:       ${show(caps.imageInput, caps.sources.imageInput)}`,
    `reasoning:         ${show(caps.reasoning, caps.sources.reasoning)}`,
  ];
}
