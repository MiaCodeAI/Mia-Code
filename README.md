# Mia Code

An open-source, cross-platform, **bring-your-own-key** AI coding assistant for the terminal.

> **Status: early development (v0.1.0, Phase 1 "Foundation").**
> This release is a **read-only chat** assistant. It is _not_ yet an autonomous coding agent.
> See [What works today](#what-works-today) and [Known limitations](#known-limitations) before relying on it.

## What works today

| Area                | Status                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Interactive session | `mia` starts a streaming chat in your project folder, with slash commands                                                 |
| One-shot questions  | `mia ask "…"` streams the answer to stdout (pipe-friendly)                                                                |
| Setup wizard        | `mia init`: provider, hidden key entry, key validation, model choice, connectivity test                                   |
| Providers           | OpenAI-compatible adapter and a native Anthropic adapter (see [provider status](docs/providers.md))                       |
| Key storage         | OS credential store (Linux Secret Service, macOS Keychain, Windows DPAPI) or environment variables; never in config files |
| Diagnostics         | `mia doctor` checks Node, config, key storage, git, providers                                                             |
| Project context     | A file-**name** overview (honouring `.gitignore` and secret/dependency exclusions) plus the first 2 KB of the README      |
| Usage               | Token counts per reply; cost estimates only when you configure a dated price                                              |
| Cancellation        | Ctrl-C stops a reply; timeouts and bounded retries for rate limits/outages                                                |

### What it cannot do yet

It **cannot read file contents, search code, edit files, run commands or tests, or use git** beyond showing the branch.
Questions that need file contents get an honest "I would need to see X". Those capabilities are the next phases
(see [ROADMAP.md](ROADMAP.md)). Nothing in this release modifies your project.

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

Inside a session: `/help`, `/context` (shows exactly what is sent), `/usage`, `/model`, `/provider`, `/status`, `/clear`, `/quit`.

## Commands

| Command                                             | Purpose                                       |
| --------------------------------------------------- | --------------------------------------------- |
| `mia`                                               | Interactive session in the current folder     |
| `mia ask [--provider p] [--model m] [--no-context]` | One question, streamed answer                 |
| `mia ask --show-context`                            | Print the project overview that would be sent |
| `mia init`                                          | Guided setup                                  |
| `mia doctor [--online] [--json]`                    | Diagnostics                                   |
| `mia auth login\|list\|remove`                      | Manage API keys                               |
| `mia provider list\|add\|test\|use\|remove`         | Manage providers                              |
| `mia model list\|use`                               | List and select models                        |
| `mia config [show\|path\|edit]`                     | Inspect or edit the config file               |
| `mia help [command]`, `mia --version`               | Help and version                              |

Every command above is implemented and covered by tests. Commands from the long-term specification that are **not** implemented
yet (`audit`, `/plan`, `/review`, `/diff`, `/undo`, `/resume`, `/compact`, …) are intentionally absent rather than stubbed.

## Privacy and API-key security

- **No telemetry, no account, no Mia Code server.** Requests go directly from your computer to the provider you configure.
- **What the provider receives:** your messages, the conversation so far, and (unless `--no-context`) a file-name overview of the
  current folder with the start of its README. Use `/context` or `mia ask --show-context` to see it. Your provider handles that data under its own terms.
- **Keys** are stored in your OS credential store, passed to helper programs on stdin (never on a command line), masked in all output,
  refused by the config writer, and only ever sent to the host you configured. Redirects are not followed.
- **Excluded from context:** `.env*` (except templates), private keys/certificates, credential files, `node_modules`, virtualenvs, build output, caches, `.git`, binaries, and anything `.gitignore` excludes.
- Details and the threat model: [docs/security.md](docs/security.md).

## Documentation

[Getting started](docs/getting-started.md) · [Providers](docs/providers.md) · [Security](docs/security.md) ·
[Architecture](docs/architecture.md) · [Adding a provider](docs/adding-a-provider.md) · [Testing](docs/testing.md) ·
[Troubleshooting](docs/troubleshooting.md) · [Releases](docs/releases.md)

## Known limitations

- Read-only chat; no file reading, editing, command execution or test running yet.
- Only plain streamed chat is implemented: no tool calling, structured output or image input.
- **Tested** here: Linux, with mocked providers and a local mock server. The macOS Keychain and Windows DPAPI backends
  and the real provider endpoints (OpenAI, Anthropic, OpenRouter, Groq, DeepSeek) have **not** been exercised against the live
  systems yet. CI runs on Windows, Linux and macOS but only mocked tests, so those paths still need real-world verification.
- Conversation history is kept in memory only; there are no saved sessions yet.
- Context handling is a bounded message window, not summarisation.
- Model capabilities are never guessed from names; they show as "unknown" unless the provider reports them or you set them in the config.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributors never need a paid API key: the test suite uses mocked providers.

## License

[Apache-2.0](LICENSE). The final licence decision and dependency licence review are still the maintainers' to confirm.
Mia Code has **no runtime dependencies**; development dependencies are listed in `package.json`.
