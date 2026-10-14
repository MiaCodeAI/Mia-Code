import { normalizeBaseUrl, EndpointError } from '../security/endpoint.js';
import { asNumber, asString, isRecord, type JsonRecord } from '../util/json.js';

export type ProviderKind = 'openai-compatible' | 'anthropic';
export type MaxTokensParam = 'max_tokens' | 'max_completion_tokens';

export interface ProviderConfig {
  kind: ProviderKind;
  baseUrl: string;
  model?: string;
  /** Preset id this provider was created from (enables the preset's standard env var). */
  preset?: string;
  /** Name of an environment variable holding the API key. The key itself is never stored here. */
  apiKeyEnv?: string;
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Which request field carries the output-token limit on OpenAI-compatible endpoints. */
  maxTokensParam?: MaxTokensParam;
}

export interface CapabilityOverride {
  contextWindow?: number;
  maxOutputTokens?: number;
  streaming?: boolean;
  tools?: boolean;
  structuredOutput?: boolean;
  imageInput?: boolean;
  reasoning?: boolean;
  notes?: string;
}

export interface PricingEntry {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Date (YYYY-MM-DD) the price was copied from the provider's pricing page. */
  asOf: string;
  currency: string;
}

export interface Limits {
  requestTimeoutMs: number;
  maxOutputTokens: number;
  maxRetries: number;
  /** Characters of file excerpts sent with a question (about 4 characters per token). */
  evidenceChars: number;
}

export interface MiaConfig {
  version: 1;
  defaultProvider?: string;
  providers: Record<string, ProviderConfig>;
  capabilities: Record<string, CapabilityOverride>;
  pricing: Record<string, PricingEntry>;
  limits: Limits;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(message: string, problems: string[] = []) {
    super(message);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export const PROVIDER_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function defaultConfig(): MiaConfig {
  return {
    version: 1,
    providers: {},
    capabilities: {},
    pricing: {},
    limits: {
      requestTimeoutMs: 120_000,
      maxOutputTokens: 4096,
      maxRetries: 2,
      evidenceChars: 20_000,
    },
  };
}

function unknownKeys(
  record: JsonRecord,
  allowed: readonly string[],
  where: string,
  errors: string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) errors.push(`${where}: unknown setting "${key}"`);
  }
}

function intInRange(
  value: unknown,
  min: number,
  max: number,
  where: string,
  errors: string[],
): number | undefined {
  if (value === undefined) return undefined;
  const n = asNumber(value);
  if (n === undefined || !Number.isInteger(n) || n < min || n > max) {
    errors.push(`${where} must be an integer between ${min} and ${max}`);
    return undefined;
  }
  return n;
}

function optionalBool(value: unknown, where: string, errors: string[]): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    errors.push(`${where} must be true or false`);
    return undefined;
  }
  return value;
}

function validateProvider(
  name: string,
  raw: unknown,
  errors: string[],
): ProviderConfig | undefined {
  const where = `providers.${name}`;
  if (!PROVIDER_NAME.test(name)) {
    errors.push(`${where}: provider names must be 1-32 characters of a-z, 0-9, "-" or "_"`);
  }
  if (!isRecord(raw)) {
    errors.push(`${where} must be an object`);
    return undefined;
  }
  unknownKeys(
    raw,
    [
      'kind',
      'baseUrl',
      'model',
      'preset',
      'apiKeyEnv',
      'maxOutputTokens',
      'temperature',
      'timeoutMs',
      'maxTokensParam',
    ],
    where,
    errors,
  );

  const kind = raw['kind'];
  if (kind !== 'openai-compatible' && kind !== 'anthropic') {
    errors.push(`${where}.kind must be "openai-compatible" or "anthropic"`);
    return undefined;
  }

  const baseUrlRaw = asString(raw['baseUrl']);
  let baseUrl = '';
  if (baseUrlRaw === undefined) {
    errors.push(`${where}.baseUrl is required`);
  } else {
    try {
      baseUrl = normalizeBaseUrl(baseUrlRaw);
    } catch (e) {
      errors.push(`${where}.baseUrl: ${e instanceof EndpointError ? e.message : 'invalid URL'}`);
    }
  }

  const provider: ProviderConfig = { kind, baseUrl };

  const model = raw['model'];
  if (model !== undefined) {
    if (typeof model === 'string' && model.trim() !== '') provider.model = model.trim();
    else errors.push(`${where}.model must be a non-empty string`);
  }
  const preset = raw['preset'];
  if (preset !== undefined) {
    if (typeof preset === 'string' && preset !== '') provider.preset = preset;
    else errors.push(`${where}.preset must be a non-empty string`);
  }
  const apiKeyEnv = raw['apiKeyEnv'];
  if (apiKeyEnv !== undefined) {
    if (typeof apiKeyEnv === 'string' && ENV_NAME.test(apiKeyEnv)) provider.apiKeyEnv = apiKeyEnv;
    else
      errors.push(`${where}.apiKeyEnv must be an environment variable NAME (not the key itself)`);
  }
  const maxOutputTokens = intInRange(
    raw['maxOutputTokens'],
    1,
    1_000_000,
    `${where}.maxOutputTokens`,
    errors,
  );
  if (maxOutputTokens !== undefined) provider.maxOutputTokens = maxOutputTokens;
  const timeoutMs = intInRange(raw['timeoutMs'], 1000, 3_600_000, `${where}.timeoutMs`, errors);
  if (timeoutMs !== undefined) provider.timeoutMs = timeoutMs;
  const temperature = raw['temperature'];
  if (temperature !== undefined) {
    const t = asNumber(temperature);
    if (t === undefined || t < 0 || t > 2)
      errors.push(`${where}.temperature must be a number between 0 and 2`);
    else provider.temperature = t;
  }
  const mtp = raw['maxTokensParam'];
  if (mtp !== undefined) {
    if (mtp === 'max_tokens' || mtp === 'max_completion_tokens') provider.maxTokensParam = mtp;
    else errors.push(`${where}.maxTokensParam must be "max_tokens" or "max_completion_tokens"`);
  }
  return provider;
}

function validateCapability(
  key: string,
  raw: unknown,
  errors: string[],
): CapabilityOverride | undefined {
  const where = `capabilities.${key}`;
  if (!isRecord(raw)) {
    errors.push(`${where} must be an object`);
    return undefined;
  }
  unknownKeys(
    raw,
    [
      'contextWindow',
      'maxOutputTokens',
      'streaming',
      'tools',
      'structuredOutput',
      'imageInput',
      'reasoning',
      'notes',
    ],
    where,
    errors,
  );
  const cap: CapabilityOverride = {};
  const contextWindow = intInRange(
    raw['contextWindow'],
    1,
    100_000_000,
    `${where}.contextWindow`,
    errors,
  );
  if (contextWindow !== undefined) cap.contextWindow = contextWindow;
  const maxOut = intInRange(
    raw['maxOutputTokens'],
    1,
    100_000_000,
    `${where}.maxOutputTokens`,
    errors,
  );
  if (maxOut !== undefined) cap.maxOutputTokens = maxOut;
  for (const flag of [
    'streaming',
    'tools',
    'structuredOutput',
    'imageInput',
    'reasoning',
  ] as const) {
    const v = optionalBool(raw[flag], `${where}.${flag}`, errors);
    if (v !== undefined) cap[flag] = v;
  }
  const notes = raw['notes'];
  if (notes !== undefined) {
    if (typeof notes === 'string') cap.notes = notes;
    else errors.push(`${where}.notes must be a string`);
  }
  return cap;
}

function validatePricing(key: string, raw: unknown, errors: string[]): PricingEntry | undefined {
  const where = `pricing.${key}`;
  if (!isRecord(raw)) {
    errors.push(`${where} must be an object`);
    return undefined;
  }
  unknownKeys(raw, ['inputPerMTok', 'outputPerMTok', 'asOf', 'currency'], where, errors);
  const input = asNumber(raw['inputPerMTok']);
  const output = asNumber(raw['outputPerMTok']);
  const asOf = asString(raw['asOf']);
  let ok = true;
  if (input === undefined || input < 0) {
    errors.push(
      `${where}.inputPerMTok must be a non-negative number (price per million input tokens)`,
    );
    ok = false;
  }
  if (output === undefined || output < 0) {
    errors.push(
      `${where}.outputPerMTok must be a non-negative number (price per million output tokens)`,
    );
    ok = false;
  }
  if (asOf === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    errors.push(
      `${where}.asOf is required and must be a date like 2026-01-31 (when the price was checked)`,
    );
    ok = false;
  }
  if (!ok || input === undefined || output === undefined || asOf === undefined) return undefined;
  return {
    inputPerMTok: input,
    outputPerMTok: output,
    asOf,
    currency: asString(raw['currency']) ?? 'USD',
  };
}

/** Validates untrusted config input. Returns all problems at once rather than stopping at the first. */
export function validateConfig(input: unknown): { config: MiaConfig; errors: string[] } {
  const errors: string[] = [];
  const config = defaultConfig();
  if (!isRecord(input)) {
    return { config, errors: ['the config file must contain a JSON object'] };
  }
  unknownKeys(
    input,
    ['version', 'defaultProvider', 'providers', 'capabilities', 'pricing', 'limits'],
    'config',
    errors,
  );

  if (input['version'] !== 1) errors.push('version must be 1');

  const providers = input['providers'];
  if (providers !== undefined) {
    if (!isRecord(providers)) errors.push('providers must be an object');
    else {
      for (const [name, raw] of Object.entries(providers)) {
        const p = validateProvider(name, raw, errors);
        if (p) config.providers[name] = p;
      }
    }
  }

  const defaultProvider = input['defaultProvider'];
  if (defaultProvider !== undefined) {
    if (typeof defaultProvider !== 'string') errors.push('defaultProvider must be a string');
    else if (!(defaultProvider in config.providers)) {
      errors.push(`defaultProvider "${defaultProvider}" is not a configured provider`);
    } else config.defaultProvider = defaultProvider;
  }

  const capabilities = input['capabilities'];
  if (capabilities !== undefined) {
    if (!isRecord(capabilities)) errors.push('capabilities must be an object');
    else {
      for (const [key, raw] of Object.entries(capabilities)) {
        const c = validateCapability(key, raw, errors);
        if (c) config.capabilities[key] = c;
      }
    }
  }

  const pricing = input['pricing'];
  if (pricing !== undefined) {
    if (!isRecord(pricing)) errors.push('pricing must be an object');
    else {
      for (const [key, raw] of Object.entries(pricing)) {
        const p = validatePricing(key, raw, errors);
        if (p) config.pricing[key] = p;
      }
    }
  }

  const limits = input['limits'];
  if (limits !== undefined) {
    if (!isRecord(limits)) errors.push('limits must be an object');
    else {
      unknownKeys(
        limits,
        ['requestTimeoutMs', 'maxOutputTokens', 'maxRetries', 'evidenceChars'],
        'limits',
        errors,
      );
      const t = intInRange(
        limits['requestTimeoutMs'],
        1000,
        3_600_000,
        'limits.requestTimeoutMs',
        errors,
      );
      if (t !== undefined) config.limits.requestTimeoutMs = t;
      const m = intInRange(
        limits['maxOutputTokens'],
        1,
        1_000_000,
        'limits.maxOutputTokens',
        errors,
      );
      if (m !== undefined) config.limits.maxOutputTokens = m;
      const r = intInRange(limits['maxRetries'], 0, 5, 'limits.maxRetries', errors);
      if (r !== undefined) config.limits.maxRetries = r;
      const e = intInRange(limits['evidenceChars'], 2000, 200_000, 'limits.evidenceChars', errors);
      if (e !== undefined) config.limits.evidenceChars = e;
    }
  }

  return { config, errors };
}
