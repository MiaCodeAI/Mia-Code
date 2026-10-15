# Verification status

What has and has not been checked on real systems. Automated tests (`npm run check`) use fakes and mock servers; they prove the logic, not that a third-party service or OS facility behaves as assumed.

| Area                                                                | How verified                                                                                                   | Status                        |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Core logic, agent loop, tools, repo index                           | Unit and integration tests on CI (Linux, macOS, Windows; Node 20, 22)                                          | Automated                     |
| Symlink-safe writes and undo                                        | Tests including race simulation (Linux anchoring path). Other platforms use a lstat + post-open identity check | Linux strongest               |
| Sandbox: bubblewrap (Linux)                                         | End-to-end tests, run when `bwrap` works                                                                       | Tested on Linux               |
| Sandbox: Seatbelt (macOS), Docker                                   | Profile/argument generation only                                                                               | **Not run on a real system**  |
| Provider wire formats (OpenAI-compatible, Anthropic)                | Mock servers                                                                                                   | Live checks are opt-in, below |
| Credential stores: macOS Keychain, Windows DPAPI, Linux secret-tool | Fake runner in CI; round-trip test below                                                                       | Live checks are opt-in        |

## Running the live checks

```bash
MIA_LIVE=1 npm run test:live
```

The credential-store test stores, reads, overwrites and deletes a random secret under a throwaway account name on the current OS (it skips with a warning if the store is unavailable). Provider tests run only when you provide keys; they send a few tiny requests:

| Variable                                                                   | Meaning                                                       |
| -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `MIA_LIVE_OPENAI_KEY`, `MIA_LIVE_OPENAI_BASE_URL`, `MIA_LIVE_OPENAI_MODEL` | OpenAI-compatible endpoint (model needed for chat/tool tests) |
| `MIA_LIVE_ANTHROPIC_KEY`, `MIA_LIVE_ANTHROPIC_MODEL`                       | Anthropic                                                     |

The **Live verification (manual)** GitHub workflow runs the same tests on Ubuntu, Windows and macOS runners; add the keys as repository secrets and models/base URL as variables. Do not paste keys into issues or logs.

Until these have been run on a given OS, treat that OS's credential store and sandbox as unverified.
