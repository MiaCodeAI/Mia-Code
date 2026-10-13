# Architecture

```
src/
  cli.ts                 entry point and command dispatch (run() returns an exit code; no process.exit)
  context.ts             Context: every side effect (fs paths, env, fetch, stdout, terminal, subprocess) injected for tests
  commands/              one file per command: init, ask, repl, auth, provider, model, config, doctor (+ setup, runtime, flags)
  config/                schema.ts (strict validation, all errors at once) and store.ts (atomic 0600 writes, secret guard)
  credentials/           CredentialStore interface + Linux / macOS / Windows backends and key resolution
  providers/             Provider interface, adapters (openai.ts, anthropic.ts), http/sse/retry helpers, error normalisation, presets, capabilities
  project/               exclusion policy, safe git access, project snapshot
  security/              redaction, endpoint validation
  session/               ChatSession (history window, usage totals, cost) and the system prompt
  platform/              config paths, subprocess runner (no shell), editor launcher
  ui/                    terminal (hidden input), ANSI styling, prompts, formatting
```

## Design decisions

- **Zero runtime dependencies.** Node's `fetch`, `readline`, `util.parseArgs` and `child_process` are enough for this phase, which keeps the
  supply chain and licence review small.
- **Dependency injection through `Context`.** Tests replace fetch, the credential store, the terminal and the subprocess runner; no test touches a network or a real keyring.
- **Provider interface** (`providers/types.ts`): `listModels()` (also the authentication check) and `streamChat()` yielding `text`, `usage` and `done`
  events. Errors are always `ProviderError` with a normalised `code`, `retryable` flag and an actionable hint.
- **Retry policy:** exponential backoff with jitter on rate limits, timeouts, 5xx and network errors; `Retry-After` honoured up to a cap.
  A streaming call is retried **only if nothing has been delivered yet**, so output is never duplicated.
- **Timeouts are inactivity timeouts**, reset on every chunk, so long answers are not cut off while a stalled connection is.
- **Redirects are not followed** by the HTTP layer: following one could forward the key to a different host.
- **Config is data, not code, and never holds secrets.** Unknown keys are errors so typos are not silently ignored.
- **Capabilities are declared or discovered, never inferred from model names.**
- **Nothing is invented:** no bundled prices, no guessed capabilities, no claimed live support.

## Extension points (planned phases)

Tool system and agent loop (Phase 3), repository index (Phase 2/4), additional adapters (Phase 5). The `Provider` interface will gain tool-calling
methods when the agent engine needs them; adapters currently implement plain streamed chat only.
