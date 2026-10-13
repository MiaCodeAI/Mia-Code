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
    input: NodeJS.ReadStream = process.stdin,
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
      input,
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

  close(): void {
    this.rl.close();
  }
}
