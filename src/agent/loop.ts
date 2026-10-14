import { ProviderError } from '../providers/errors.js';
import type { ChatMessage, Provider, ToolCall, Usage } from '../providers/types.js';
import { decide, type PermissionMode } from './policy.js';
import { limitText, toolByName, type Tool, type ToolEnv } from './tools.js';

export type Approval = 'yes' | 'no' | 'always';

export interface ApprovalRequest {
  tool: string;
  risk: 'write' | 'exec';
  summary: string;
  /** Diff or details to review before answering. */
  preview?: string;
}

export interface AgentHooks {
  onText?(text: string): void;
  onToolStart?(tool: string, summary: string): void;
  onToolResult?(tool: string, result: { content: string; isError: boolean }, summary: string): void;
  onNotice?(message: string): void;
  /** Asked for write/exec actions the current mode does not auto-approve. */
  approve(request: ApprovalRequest): Promise<Approval>;
}

export interface AgentTurnOptions {
  provider: Provider;
  model: string;
  system: string;
  tools: readonly Tool[];
  toolEnv: ToolEnv;
  mode: PermissionMode;
  hooks: AgentHooks;
  maxSteps?: number;
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export type StopReason = 'done' | 'cancelled' | 'max-steps' | 'repeated-failure' | 'repeated-call';

export interface AgentTurnResult {
  stop: StopReason;
  steps: number;
  usage: Usage;
  text: string;
  toolCalls: number;
}

const MAX_HISTORY_CHARS = 300_000;
const KEEP_RECENT = 14;

/** Conversation state for the agent. Tool calls and results are kept so the model sees what it did. */
export class AgentSession {
  readonly messages: ChatMessage[] = [];
  readonly totals = { requests: 0, inputTokens: 0, outputTokens: 0 };
  private readonly alwaysAllowed = new Set<string>();

  clear(): void {
    this.messages.length = 0;
    this.alwaysAllowed.clear();
  }

  allow(key: string): void {
    this.alwaysAllowed.add(key);
  }
  isAllowed(key: string): boolean {
    return this.alwaysAllowed.has(key);
  }

  /** Keeps the history bounded: old tool output is shortened first, then the oldest turns are dropped. */
  private compact(): void {
    const size = (): number =>
      this.messages.reduce(
        (n, m) => n + m.content.length + JSON.stringify(m.toolCalls ?? []).length,
        0,
      );
    if (size() <= MAX_HISTORY_CHARS) return;
    for (let i = 0; i < this.messages.length - KEEP_RECENT && size() > MAX_HISTORY_CHARS; i++) {
      const m = this.messages[i];
      if (m && m.role === 'tool' && m.content.length > 400)
        m.content = `${m.content.slice(0, 300)}\n… [older output shortened to save context]`;
    }
    while (size() > MAX_HISTORY_CHARS && this.messages.length > KEEP_RECENT) {
      // Drop the oldest whole turn (up to the next user message) so tool calls and results stay paired.
      let next = 1;
      while (next < this.messages.length && this.messages[next]?.role !== 'user') next++;
      if (next >= this.messages.length) break;
      this.messages.splice(0, next);
    }
  }

  async runTurn(userText: string, options: AgentTurnOptions): Promise<AgentTurnResult> {
    const { provider, hooks } = options;
    const maxSteps = options.maxSteps ?? 25;
    const specs = options.tools.map((t) => t.spec);
    this.messages.push({ role: 'user', content: userText });
    const userIndex = this.messages.length - 1;
    const usage: Usage = {};
    const addUsage = (u: Usage): void => {
      if (u.inputTokens !== undefined) usage.inputTokens = (usage.inputTokens ?? 0) + u.inputTokens;
      if (u.outputTokens !== undefined)
        usage.outputTokens = (usage.outputTokens ?? 0) + u.outputTokens;
    };
    let finalText = '';
    let toolCalls = 0;
    let consecutiveErrors = 0;
    const seen = new Map<string, number>();

    for (let step = 1; step <= maxSteps; step++) {
      this.compact();
      let text = '';
      const calls: ToolCall[] = [];
      let stepUsage: Usage = {};
      try {
        const stream = provider.streamChat({
          model: options.model,
          messages: [{ role: 'system', content: options.system }, ...this.messages],
          tools: specs,
          ...(options.maxOutputTokens !== undefined
            ? { maxOutputTokens: options.maxOutputTokens }
            : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        for await (const event of stream) {
          if (event.type === 'text') {
            text += event.text;
            hooks.onText?.(event.text);
          } else if (event.type === 'tool_call') calls.push(event.call);
          else if (event.type === 'usage') stepUsage = { ...stepUsage, ...event.usage };
        }
      } catch (error) {
        addUsage(stepUsage);
        this.totals.requests++;
        if (error instanceof ProviderError && error.code === 'cancelled') {
          if (text !== '') this.messages.push({ role: 'assistant', content: text });
          return { stop: 'cancelled', steps: step, usage, text: finalText + text, toolCalls };
        }
        // Keep completed work, but do not leave a dangling question behind if nothing happened yet.
        if (this.messages.length - 1 === userIndex) this.messages.pop();
        throw error;
      }
      addUsage(stepUsage);
      this.totals.requests++;
      this.totals.inputTokens += stepUsage.inputTokens ?? 0;
      this.totals.outputTokens += stepUsage.outputTokens ?? 0;
      finalText += text;
      this.messages.push({
        role: 'assistant',
        content: text,
        ...(calls.length > 0 ? { toolCalls: calls } : {}),
      });
      if (calls.length === 0)
        return { stop: 'done', steps: step, usage, text: finalText, toolCalls };

      for (let i = 0; i < calls.length; i++) {
        const call = calls[i]!;
        if (options.signal?.aborted) {
          for (const rest of calls.slice(i)) {
            this.messages.push({
              role: 'tool',
              toolCallId: rest.id,
              toolName: rest.name,
              content: 'Cancelled by the user before running.',
              isError: true,
            });
          }
          return { stop: 'cancelled', steps: step, usage, text: finalText, toolCalls };
        }
        toolCalls++;
        const result = await this.execute(call, options);
        consecutiveErrors = result.isError ? consecutiveErrors + 1 : 0;
        this.messages.push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: limitText(result.content),
          isError: result.isError,
        });

        const signature = `${call.name}:${JSON.stringify(call.arguments)}`;
        const times = (seen.get(signature) ?? 0) + 1;
        seen.set(signature, times);
        if (
          times >= 3 &&
          (result.isError ||
            call.name === 'run_tests' ||
            call.name.startsWith('edit') ||
            call.name.startsWith('write') ||
            call.name === 'run_command')
        ) {
          this.finishPending(
            calls.slice(i + 1),
            'Skipped: the same action was repeated too many times.',
          );
          hooks.onNotice?.(
            `Stopped: "${call.name}" was attempted ${times} times with the same arguments.`,
          );
          return {
            stop: result.isError ? 'repeated-failure' : 'repeated-call',
            steps: step,
            usage,
            text: finalText,
            toolCalls,
          };
        }
        if (consecutiveErrors >= 4) {
          this.finishPending(calls.slice(i + 1), 'Skipped: too many consecutive failures.');
          hooks.onNotice?.(
            'Stopped: four tool calls in a row failed. Tell me how you want to proceed.',
          );
          return { stop: 'repeated-failure', steps: step, usage, text: finalText, toolCalls };
        }
      }
    }
    hooks.onNotice?.(`Reached the step limit (${maxSteps}). Send another message to continue.`);
    return { stop: 'max-steps', steps: maxSteps, usage, text: finalText, toolCalls };
  }

  private finishPending(calls: ToolCall[], message: string): void {
    for (const c of calls)
      this.messages.push({
        role: 'tool',
        toolCallId: c.id,
        toolName: c.name,
        content: message,
        isError: true,
      });
  }

  private async execute(
    call: ToolCall,
    options: AgentTurnOptions,
  ): Promise<{ content: string; isError: boolean }> {
    const { hooks } = options;
    const tool = options.tools.find((t) => t.spec.name === call.name) ?? toolByName(call.name);
    if (!tool || !options.tools.includes(tool)) {
      return {
        content: `Unknown tool "${call.name}". Available: ${options.tools.map((t) => t.spec.name).join(', ')}.`,
        isError: true,
      };
    }
    if (call.invalidArguments) {
      return {
        content: `The arguments for ${call.name} could not be used (${call.invalidArguments}). Send a valid JSON object.`,
        isError: true,
      };
    }
    const summary = tool.describe(call.arguments);
    const decision = decide(options.mode, tool.risk);
    if (decision === 'deny') {
      return {
        content: `Not allowed in ${options.mode} mode: ${summary}. Explain what you would change and let the user switch modes (/mode).`,
        isError: true,
      };
    }

    let preview: string | undefined;
    if (tool.preview) {
      const p = await tool.preview(call.arguments, options.toolEnv);
      if ('error' in p) return { content: p.error, isError: true };
      preview = p.text;
    }
    if (decision === 'ask') {
      const key = `${tool.spec.name}:${tool.risk === 'exec' ? summary : '*'}`;
      if (!this.isAllowed(key)) {
        const answer = await hooks.approve({
          tool: tool.spec.name,
          risk: tool.risk as 'write' | 'exec',
          summary,
          ...(preview !== undefined ? { preview } : {}),
        });
        if (answer === 'no') {
          return {
            content: 'The user declined this action. Do not retry it; ask what they want instead.',
            isError: true,
          };
        }
        if (answer === 'always') this.allow(key);
      }
    }
    hooks.onToolStart?.(tool.spec.name, summary);
    let result: { content: string; isError: boolean };
    try {
      result = await tool.execute(call.arguments, options.toolEnv);
    } catch (error) {
      result = { content: `The tool failed: ${(error as Error).message}`, isError: true };
    }
    hooks.onToolResult?.(tool.spec.name, result, summary);
    return result;
  }
}
