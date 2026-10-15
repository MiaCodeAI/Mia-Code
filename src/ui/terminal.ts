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
    const rows = out.rows || 24;
    const windowSize = Math.max(3, Math.min(options.length, 10, rows - 5));
    const width = Math.max(20, (out.columns || 80) - 4);
    let filter = '';
    let view: number[] = options.map((_, i) => i);
    let cursor = 0;
    let top = 0;
    let drawn = 0;

    const clip = (text: string): string =>
      text.length > width ? `${text.slice(0, width - 1)}…` : text;
    const refilter = (): void => {
      const f = filter.toLowerCase();
      view = options.flatMap((o, i) => (o.toLowerCase().includes(f) ? [i] : []));
      cursor = 0;
      top = 0;
    };
    const draw = (): void => {
      const total = view.length;
      if (cursor < top) top = cursor;
      if (cursor >= top + windowSize) top = cursor - windowSize + 1;
      if (drawn > 0) out.write(`\x1b[${drawn}A`);
      const lines: string[] = [];
      for (let i = top; i < Math.min(total, top + windowSize); i++) {
        const text = clip(options[view[i] ?? 0] ?? '');
        lines.push(i === cursor ? `\x1b[36m❯ ${text}\x1b[0m` : `  ${text}`);
      }
      if (total === 0) lines.push('  (nothing matches; Backspace to edit the filter)');
      while (lines.length < Math.min(windowSize, options.length)) lines.push('');
      const more = `${top > 0 ? '↑ more  ' : ''}${top + windowSize < total ? '↓ more  ' : ''}`;
      const searchable = options.length > windowSize;
      lines.push(
        `\x1b[2m${more}(${total === 0 ? 0 : cursor + 1}/${total})  ↑/↓ move · Enter select · Esc cancel${searchable ? ' · type to filter' : ''}\x1b[0m`,
      );
      if (searchable) lines.push(`\x1b[2mfilter:\x1b[0m ${filter}`);
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
      const onKey = (str: string | undefined, key: readline.Key | undefined): void => {
        const total = view.length;
        const page = Math.max(1, windowSize - 1);
        if (key?.ctrl && (key.name === 'c' || key.name === 'd')) return finish(null);
        switch (key?.name) {
          case 'up':
            if (total > 0) cursor = (cursor - 1 + total) % total;
            break;
          case 'down':
            if (total > 0) cursor = (cursor + 1) % total;
            break;
          case 'pageup':
            cursor = Math.max(0, cursor - page);
            break;
          case 'pagedown':
            cursor = Math.max(0, Math.min(total - 1, cursor + page));
            break;
          case 'home':
            cursor = 0;
            break;
          case 'end':
            cursor = Math.max(0, total - 1);
            break;
          case 'return':
          case 'enter':
            if (total === 0) return;
            return finish(view[cursor] ?? null);
          case 'escape':
            return finish(null);
          case 'backspace':
            if (filter === '') return;
            filter = filter.slice(0, -1);
            refilter();
            break;
          default:
            if (
              str &&
              str.length === 1 &&
              str >= ' ' &&
              str !== '\x7f' &&
              !key?.ctrl &&
              !key?.meta
            ) {
              filter += str;
              refilter();
              break;
            }
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
