# Testing

```bash
npm run check      # format check, lint, typecheck, tests
npm test           # tests only (vitest)
npm run build      # compile to dist/
```

No test needs an API key, a network connection, a keyring or a terminal. Providers are mocked with a fake `fetch`; the credential store,
terminal and subprocess runner are injected (`tests/helpers/fakes.ts`).

## What is covered

| Area              | Tests                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Config            | validation (all errors reported), atomic write, 0600 mode, key-in-config refusal                                                           |
| Redaction         | known key shapes, bearer tokens, key=value, PEM blocks, registered secrets, no false positives                                             |
| Endpoints / paths | https rule, loopback lookalikes, per-platform config directories                                                                           |
| SSE / providers   | arbitrary chunking, CRLF, UTF-8 splits; both adapters: streaming, usage, retries, no-retry-after-output, redirects, cancellation, timeouts |
| Errors            | status mapping, quota vs rate limit, key redaction in messages, TLS hint                                                                   |
| Credentials       | stdin-only secrets, shell-injection refusal, key resolution order, subprocess runner                                                       |
| Project context   | exclusions, symlinks, `.gitignore`/git integration, truncation                                                                             |
| Session           | history window, failure/cancel handling, usage totals, cost refusal without data                                                           |
| CLI end-to-end    | init wizard, login/validation/storage, no key in any output, ask/REPL/doctor/config                                                        |

## Not covered yet

Live providers, the real macOS Keychain and Windows DPAPI, and real terminals (hidden input, Ctrl-C) are not exercised by automated tests. CI runs the suite on
Ubuntu, Windows and macOS (Node 20 and 22), which verifies path handling and platform-neutral code but not those integrations. Manual
verification notes from contributors are welcome.

## Optional live checks

There is no live-provider test suite yet. When one is added it must be opt-in, require the contributor's own key, and never run in CI by default.
