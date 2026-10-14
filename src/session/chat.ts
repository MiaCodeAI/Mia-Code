import type { PricingEntry } from '../config/schema.js';
import { ProviderError } from '../providers/errors.js';
import type { ChatMessage, ChatRequest, Provider, Usage } from '../providers/types.js';

export interface SendOptions {
  provider: Provider;
  model: string;
  system: string;
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  onText?: (text: string) => void;
}

export interface TurnResult {
  text: string;
  usage: Usage;
  stopReason?: string;
  /** True when the user cancelled; the partial answer is shown but not kept in history. */
  cancelled: boolean;
}

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Requests for which the provider reported no token counts. */
  unreported: number;
}

export interface CostEstimate {
  amount: number;
  currency: string;
  asOf: string;
}

/** Cost is only estimated when both a dated price and complete token counts are available. */
export function estimateCost(pricing: PricingEntry | undefined, usage: Usage): CostEstimate | null {
  if (!pricing || usage.inputTokens === undefined || usage.outputTokens === undefined) return null;
  const amount =
    (usage.inputTokens / 1_000_000) * pricing.inputPerMTok +
    (usage.outputTokens / 1_000_000) * pricing.outputPerMTok;
  return { amount, currency: pricing.currency, asOf: pricing.asOf };
}

export class ChatSession {
  private messages: ChatMessage[] = [];
  readonly totals: UsageTotals = { requests: 0, inputTokens: 0, outputTokens: 0, unreported: 0 };

  constructor(private readonly maxMessages = 40) {}

  get length(): number {
    return this.messages.length;
  }

  clear(): void {
    this.messages = [];
  }

  /** The most recent messages, always starting with a user message. */
  private window(): ChatMessage[] {
    let recent = this.messages.slice(-this.maxMessages);
    while (recent.length > 0 && recent[0]?.role !== 'user') recent = recent.slice(1);
    return recent;
  }

  async send(userText: string, options: SendOptions): Promise<TurnResult> {
    this.messages.push({ role: 'user', content: userText });
    const request: ChatRequest = {
      model: options.model,
      messages: [{ role: 'system', content: options.system }, ...this.window()],
    };
    if (options.maxOutputTokens !== undefined) request.maxOutputTokens = options.maxOutputTokens;
    if (options.temperature !== undefined) request.temperature = options.temperature;
    if (options.signal) request.signal = options.signal;

    let text = '';
    const usage: Usage = {};
    let stopReason: string | undefined;
    try {
      for await (const event of options.provider.streamChat(request)) {
        if (event.type === 'text') {
          text += event.text;
          options.onText?.(event.text);
        } else if (event.type === 'usage') {
          if (event.usage.inputTokens !== undefined) usage.inputTokens = event.usage.inputTokens;
          if (event.usage.outputTokens !== undefined) usage.outputTokens = event.usage.outputTokens;
        } else if (event.type === 'done' && event.stopReason !== undefined) {
          stopReason = event.stopReason;
        }
      }
    } catch (error) {
      // Drop the unanswered question so the conversation stays well-formed and can be retried.
      this.messages.pop();
      if (error instanceof ProviderError && error.code === 'cancelled') {
        return { text, usage, cancelled: true };
      }
      throw error;
    }

    this.messages.push({ role: 'assistant', content: text });
    this.totals.requests += 1;
    if (usage.inputTokens === undefined && usage.outputTokens === undefined)
      this.totals.unreported += 1;
    this.totals.inputTokens += usage.inputTokens ?? 0;
    this.totals.outputTokens += usage.outputTokens ?? 0;

    const result: TurnResult = { text, usage, cancelled: false };
    if (stopReason !== undefined) result.stopReason = stopReason;
    return result;
  }
}
