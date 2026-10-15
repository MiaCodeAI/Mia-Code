# Mia Code

An open-source, cross-platform, **bring-your-own-key** AI coding assistant for the terminal.

> **Status: early development (v0.4.0, Phase 4 "Hardening").**
> Mia Code reads, searches, audits and edits your project, runs your tests and commands, and asks before changing anything by default.
> It has **not** been verified against live providers, and the macOS/Windows credential stores and the Seatbelt/Docker sandboxes have not been run on real systems
> (see [docs/verification.md](docs/verification.md)). Read [Known limitations](#known-limitations) before relying on it.

## What works today

| Area                | Status                                                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interactive session | `mia` starts a streaming chat in your project folder, with slash commands                                                                                                                 |
| One-shot questions  | `mia ask "…"` streams the answer to stdout (pipe-friendly)                                                                                                                                |
| Coding agent        | `mia run` and the session read, search, edit (diff shown), run tests and commands; modes `readonly`, `ask`, `auto-edit`, `auto`                                                           |
| Sandbox             | Commands run in an OS sandbox when available: bubblewrap on Linux (tested), Seatbelt on macOS and Docker (**unverified**). Network off by default. `auto` mode refuses to run without one |
| Plan mode           | `--plan` / `/plan`: the agent proposes steps and files, you approve, revise or cancel; step progress is shown                                                                             |
| Project guidance    | `MIA.md`, `AGENTS.md` and a global `MIA.md` (fenced as guidance; they can never grant permissions); skills in `.mia/skills/<name>/SKILL.md`                                               |
| Verify and repair   | After edits Mia runs checks (detected, `--check`, or listed in `MIA.md`), shows failures, tries up to N repairs, and prints a summary of changed files, checks run and what still fails   |
| Review and undo     | Per-file approval, `/diff`, `/undo`, `/revert <path>`, a heuristic final review (unrelated edits, missing tests, weakened tests), and tracking of files changed by shell commands         |
| Safe file I/O       | Writes and undo revalidate paths at the moment of writing and refuse symlink swaps (strongest on Linux)                                                                                   |
| Setup and keys      | `mia init`; OS credential store (Secret Service, Keychain, DPAPI) or env vars; several keys per provider with automatic rotation                                                          |
| Providers           | OpenAI-compatible adapter and a native Anthropic adapter, both with tool calling (see [provider status](docs/providers.md))                                                               |
| Repo tools          | `mia scan`, `mia search`, `mia audit` run locally and send nothing                                                                                                                        |
| Benchmark           | `npm run bench` (see [docs/testing.md](docs/testing.md)): retrieval, task completion, checks, unrelated changes                                                                           |
| Diagnostics         | `mia doctor` checks Node, config, key storage, git and providers                                                                                                                          |

### What it cannot do yet

It cannot use MCP servers (GitHub, issue trackers), run isolated background tasks or git worktrees, resume saved sessions, or use providers other than the two adapters above.
Shell-made changes are detected but only partly undoable. See [ROADMAP.md](ROADMAP.md).

## Install

Requires **Node.js 20 or newer**.

```bash
# from a clone of this repository (npm publishing has not happened yet)
npm install
npm run build
npm link            # makes the `mia` command available
mia --version
```

The npm package name `mia-code` has **not** been checked for availability or published. See [docs/releases.md](docs/releases.md).

## Quick start

```bash
cd my-project
mia init            # connect a provider with your own API key
mia                 # start chatting about the project
```

Scripted setup (no terminal needed):

```bash
mia provider add --preset openai --use
printf %s "$OPENAI_API_KEY" | mia auth login openai --stdin
mia model use <model-id>
mia provider test
```

Inside a session: `/plan`, `/skill`, `/skills`, `/instructions`, `/mode`, `/diff`, `/undo`, `/revert`, `/keys`, `/scan`, `/search`, `/audit`, `/help`, `/context` (shows exactly what is sent), `/usage`, `/model`, `/provider`, `/status`, `/clear`, `/quit`.

## Commands

| Command                                                                                 | Purpose                                                 |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `mia`                                                                                   | Interactive session in the current folder               |
| `mia ask [--provider p] [--model m] [--no-context] [--no-evidence]`                     | One question, streamed answer                           |
| `mia ask --show-context`                                                                | Print the overview and file excerpts that would be sent |
| `mia scan [--json\|--full]`                                                             | Repository map (local only)                             |
| `mia search [-e] [-i] [--symbol] <text>`                                                | Search project files (local only)                       |
| `mia audit [--mode m] [--format f] [--fail-on s]`                                       | Read-only static audit (local only)                     |
| `mia run [--mode m] [--plan] [--check cmd] [--review] [--sandbox s] [--network] <task>` | One agent task (reads, edits, verifies)                 |
| `mia auth login <p> --label <name>`                                                     | Add another API key for automatic rotation              |
| `mia init`                                                                              | Guided setup                                            |
| `mia doctor [--online] [--json]`                                                        | Diagnostics                                             |
| `mia auth login\|list\|remove`                                                          | Manage API keys                                         |
| `mia provider list\|add\|test\|use\|remove`                                             | Manage providers                                        |
| `mia model list\|use`                                                                   | List and select models                                  |
| `mia config [show\|path\|edit]`                                                         | Inspect or edit the config file                         |
| `mia help [command]`, `mia --version`                                                   | Help and version                                        |

Every command above is implemented and covered by tests. Commands from the long-term specification that are **not** implemented
yet (`/resume`, `/compact`, MCP and background-task commands) are intentionally absent rather than stubbed.

## Privacy and API-key security

- **No telemetry, no account, no Mia Code server.** Requests go directly from your computer to the provider you configure.
- **What the provider receives:** your messages, the conversation so far, and (unless `--no-context`) a file-name overview of the
  current folder plus excerpts of the files judged relevant to each question (unless `--no-evidence`); the files are listed before sending. Use `/context` or `mia ask --show-context` to see it. Your provider handles that data under its own terms.
- **Keys** are stored in your OS credential store, passed to helper programs on stdin (never on a command line), masked in all output,
  refused by the config writer, and only ever sent to the host you configured. Redirects are not followed.
- **Excluded from context:** `.env*` (except templates), private keys/certificates, credential files, `node_modules`, virtualenvs, build output, caches, `.git`, binaries, and anything `.gitignore` excludes.
- Details and the threat model: [docs/security.md](docs/security.md).

## Documentation

[Getting started](docs/getting-started.md) · [Providers](docs/providers.md) · [Security](docs/security.md) ·
[Architecture](docs/architecture.md) · [Adding a provider](docs/adding-a-provider.md) · [Testing](docs/testing.md) ·
[Troubleshooting](docs/troubleshooting.md) · [Verification status](docs/verification.md) · [Releases](docs/releases.md)

## Known limitations

- **Not verified live:** the real provider endpoints (OpenAI, Anthropic, OpenRouter, Groq, DeepSeek), the macOS Keychain and Windows DPAPI stores, and the Seatbelt and Docker sandboxes. CI runs on Windows, Linux and macOS with mocked tests only. Opt-in live checks exist (`MIA_LIVE=1 npm run test:live`, [docs/verification.md](docs/verification.md)).
- **No OS sandbox on Windows** without WSL2 or Docker. Without a sandbox, commands run with your full user permissions; the command block list is a guardrail, not a boundary. `auto` mode refuses to start unsandboxed unless you pass `--unsafe-no-sandbox`.
- Tool calling depends on the model and endpoint; some OpenAI-compatible servers reject `tools` (use `/mode chat`).
- Verify-and-repair detects test, lint, type-check and build commands heuristically (evaluated on 34 fixtures across many ecosystems, see `bench/`); unusual projects need `--check` or a `mia-checks` block in `MIA.md`.
- The final review is heuristic pattern checking, not a code review by a human or a guarantee of correctness.
- Shell changes are detected by comparing file signatures; ignored, dependency and secret files are not watched, and only clean git-tracked files can be undone.
- Conversation history is kept in memory only; there are no saved sessions yet.
- Model capabilities are never guessed from names; they show as "unknown" unless the provider reports them or you set them in the config.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributors never need a paid API key: the test suite uses mocked providers.

## License

[Apache-2.0](LICENSE). The final licence decision and dependency licence review are still the maintainers' to confirm.
Mia Code has **no runtime dependencies**; development dependencies are listed in `package.json`.
