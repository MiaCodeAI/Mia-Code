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

| Agent | symlink-swap races, sandbox arguments and (when bubblewrap works) real isolation, plan mode, instructions/skills, verify-and-repair, review, shell tracking |
| Detection | 34 table-driven fixtures across ecosystems (`tests/detect-eval.test.ts`, cases in `bench/detect-cases.ts`) |

## Benchmark

`bench/` holds small real tasks (in a copy of Mia Code's own source and in Node and Python fixtures). Each task has a check command and expected files.
`npm run bench:oracle` applies the known-good fix to prove every task is solvable and every check discriminates; `npm run bench:validate` runs that validation in the test suite.
`npm run bench` runs the agent against a real provider and records, per task: whether the right files were picked (retrieval recall), whether the task completed, whether checks pass,
and whether unrelated files changed. Results go to `bench/results/` (git-ignored). Offline retrieval metrics need no key. No comparison with other agents is claimed.

## Not covered yet

Live providers, the real macOS Keychain and Windows DPAPI, the Seatbelt and Docker sandboxes, and real terminals (hidden input, Ctrl-C) are not exercised by automated tests. CI runs the suite on
Ubuntu, Windows and macOS (Node 20 and 22), which verifies path handling and platform-neutral code but not those integrations.

## Optional live checks

`MIA_LIVE=1 npm run test:live` runs opt-in credential-store and provider checks with your own keys; it never runs in the default suite or CI. See [verification.md](verification.md).
