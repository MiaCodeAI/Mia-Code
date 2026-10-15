import readline from 'node:readline';
import { Writable } from 'node:stream';

export interface Terminal {
  /** True when stdin is a real terminal (so hidden key entry and Ctrl-C handling work). */
  readonly interactive: boolean;
  /** Returns null at end of input. */
  readLine(prompt: string): Promise<string | null>;
  /** Reads a line without echoing it. On a pipe, reads the next line as-is. */
  readSecret(prompt: string): Promise<string | null>;
  /** Called when the user presses Ctrl-C. Without a handler, input is closed. */
  onInterrupt(handler: (() => void) | undefined): void;
  /** Resolves a pending readLine with an empty line (used to leave a prompt on Ctrl-C). */
  cancelPending?(): void;
  /**
   * Arrow-key menu (up/down, PageUp/PageDown, Home/End, Enter, Esc). Only present on real terminals.
   * Resolves the chosen index, or null when cancelled.
   */
  select?(label: string, options: readonly string[]): Promise<number | null>;
  close(): void;
}

/**
 * One shared readline interface per process. Lines are queued so that piped input
 * (several answers arriving at once) is never lost between prompts.
 */
export class StdioTerminal implements Terminal {
  readonly interactive: boolean;
  private readonly rl: readline.Interface;
  private muted = false;
  private closed = false;
  private queue: string[] = [];
  private waiters: ((line: string | null) => void)[] = [];
  private interruptHandler: (() => void) | undefined;

  constructor(
    private readonly input: NodeJS.ReadStream = process.stdin,
    private readonly output: NodeJS.WriteStream = process.stdout,
  ) {
    this.interactive = Boolean(input.isTTY);
    // All readline output goes through this sink so echo can be switched off for secrets.
    const sink = new Writable({
      write: (chunk: Buffer | string, _encoding, callback) => {
        if (!this.muted) this.output.write(chunk);
        callback();
      },
    });
    Object.defineProperty(sink, 'columns', { get: () => this.output.columns });
    this.rl = readline.createInterface({
      input: this.input,
      output: sink,
      terminal: this.interactive,
      historySize: 100,
    });
    this.rl.on('line', (line) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      else this.queue.push(line);
    });
    this.rl.on('close', () => {
      this.closed = true;
      const pending = this.waiters;
      this.waiters = [];
      for (const waiter of pending) waiter(null);
    });
    this.rl.on('SIGINT', () => {
      if (this.interruptHandler) this.interruptHandler();
      else this.rl.close();
    });
  }

  onInterrupt(handler: (() => void) | undefined): void {
    this.interruptHandler = handler;
  }

  cancelPending(): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter('');
  }

  async readLine(prompt: string): Promise<string | null> {
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;
    if (this.closed) return null;
    this.rl.setPrompt(prompt);
    this.rl.prompt();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async readSecret(prompt: string): Promise<string | null> {
    if (!this.interactive) return this.readLine('');
    this.output.write(prompt);
    this.muted = true;
    try {
      return await this.readLine('');
    } finally {
      this.muted = false;
      this.output.write('\n');
      // Keep the secret out of the arrow-up history buffer.
      (this.rl as unknown as { history?: string[] }).history?.shift();
    }
  }

  /** Present only when stdin can switch to raw mode (a real terminal). */
  get select(): Terminal['select'] {
    if (!this.interactive || typeof this.input.setRawMode !== 'function') return undefined;
    return (label, options) => this.runSelect(label, options);
  }

  private runSelect(label: string, options: readonly string[]): Promise<number | null> {
    const input = this.input;
    const out = this.output;
    const total = options.length;
    const rows = out.rows || 24;
    const windowSize = Math.max(3, Math.min(total, 10, rows - 4));
    const width = Math.max(20, (out.columns || 80) - 4);
    let cursor = 0;
    let top = 0;
    let drawn = 0;

    const clip = (text: string): string =>
      text.length > width ? `${text.slice(0, width - 1)}…` : text;
    const draw = (): void => {
      if (cursor < top) top = cursor;
      if (cursor >= top + windowSize) top = cursor - windowSize + 1;
      if (drawn > 0) out.write(`\x1b[${drawn}A`);
      const lines: string[] = [];
      for (let i = top; i < Math.min(total, top + windowSize); i++) {
        const text = clip(options[i] ?? '');
        lines.push(i === cursor ? `\x1b[36m❯ ${text}\x1b[0m` : `  ${text}`);
      }
      const above = top > 0 ? '↑ more  ' : '';
      const below = top + windowSize < total ? '↓ more  ' : '';
      lines.push(
        `\x1b[2m${above}${below}(${cursor + 1}/${total})  ↑/↓ move · Enter select · Esc cancel\x1b[0m`,
      );
      out.write(lines.map((l) => `\x1b[2K${l}\n`).join(''));
      drawn = lines.length;
    };

    return new Promise((resolve) => {
      const saved = input.listeners('keypress') as ((...args: unknown[]) => void)[];
      input.removeAllListeners('keypress');
      const wasRaw = input.isRaw;
      input.setRawMode(true);
      input.resume();
      out.write(`${label} (use the arrow keys)\n\x1b[?25l`);
      draw();
      const finish = (value: number | null): void => {
        input.removeListener('keypress', onKey);
        for (const l of saved) input.on('keypress', l);
        if (!wasRaw) input.setRawMode(false);
        out.write(`\x1b[${drawn}A\x1b[J\x1b[?25h`);
        out.write(`${label}: ${value === null ? '(cancelled)' : (options[value] ?? '')}\n`);
        resolve(value);
      };
      const onKey = (_s: string | undefined, key: readline.Key | undefined): void => {
        if (!key) return;
        const page = Math.max(1, windowSize - 1);
        if (key.ctrl && (key.name === 'c' || key.name === 'd')) return finish(null);
        switch (key.name) {
          case 'up':
          case 'k':
            cursor = (cursor - 1 + total) % total;
            break;
          case 'down':
          case 'j':
            cursor = (cursor + 1) % total;
            break;
          case 'pageup':
            cursor = Math.max(0, cursor - page);
            break;
          case 'pagedown':
            cursor = Math.min(total - 1, cursor + page);
            break;
          case 'home':
            cursor = 0;
            break;
          case 'end':
            cursor = total - 1;
            break;
          case 'return':
          case 'enter':
            return finish(cursor);
          case 'escape':
            return finish(null);
          default:
            return;
        }
        draw();
      };
      input.on('keypress', onKey);
    });
  }

  close(): void {
    this.rl.close();
  }
}
