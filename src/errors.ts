/** An expected problem the user can act on. The message is shown without a stack trace. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

/** Wrong command or flags. Exit code 2. */
export class UsageError extends UserError {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}
