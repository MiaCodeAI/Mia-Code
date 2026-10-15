# Changelog

All notable changes are documented here. Format based on Keep a Changelog; versioning is semantic.

## [0.4.0] - Unreleased

Phase 4: hardening and a more dependable workflow.

### Added

- OS sandbox for commands: bubblewrap (tested on Linux), Seatbelt and Docker (unverified). Read-only file system, writable project only, `$HOME` hidden, secret files masked, network off by default. Flags `--sandbox`, `--network`, `--sandbox-image`, `--allow-write`, `--unsafe-no-sandbox`. `auto` mode requires a sandbox.
- Plan mode (`--plan`, `/plan`): propose, approve/revise/cancel, step progress.
- `MIA.md`, `AGENTS.md`, global `MIA.md` (with precedence, fenced as guidance), `mia-checks` blocks, and skills (`.mia/skills/<name>/SKILL.md` plus built-ins; `/skill`, `/skills`, `use_skill`).
- Verify-and-repair loop: `--check`, `--no-verify`, `--repair <n>`, final summary of changed files, checks run and remaining failures.
- Review: per-file approval, `--review`, `/revert <path>`, heuristic final review (unrelated edits, missing or weakened tests, leftovers), shell change tracking.
- Detection evaluation set (34 cases) and detection fixes for Python, Go, Rust, JVM, .NET, Ruby, PHP, Swift, Dart, Elixir, Deno and bun.
- Benchmark (`npm run bench`, `bench:oracle`, `bench:validate`).
- Opt-in live checks (`MIA_LIVE=1 npm run test:live`), a manual workflow, and `docs/verification.md`.

### Changed

- Arrow-key (scrolling) menus for provider and model choice on real terminals; numbered fallback for pipes.
- Linux without `secret-tool`/keyring: opt-in private key file fallback (`0600`, not encrypted) so keys can be saved; `auth login --file-store`. Wrong-provider key hint on 401.
- `npm run build` sets the executable bit on `dist/cli.js` (fixes `Permission denied` after `npm link`).
- File writes, reads and undo are symlink-safe and revalidated at the mutation point.
- The repo index compares exact nanosecond timestamps, inode and size, and re-reads recently modified files, so fast same-size edits are detected.
- README and security guide brought up to date.

### Known limitations

See README "Known limitations" and `docs/verification.md`.

## [0.3.0] - Unreleased

Phase 3: Controlled coding agent, plus multi-key rotation and the MIA CODE banner.

### Added

- Agent loop with native tool calling (OpenAI-compatible and Anthropic adapters stream tool calls). Tools: `read_file`, `list_files`, `search_code`, `find_symbol`, `edit_file` (exact replacement), `write_file`, `run_command`, `run_tests`, `git_status`, `git_diff`, `git_log`, `git_commit`.
- Permission modes: `readonly`, `ask` (default), `auto-edit`, `auto`; plus `chat` (no tools) in the interactive session. Edits show a diff before approval; "always" is available per session.
- Hard safety blocks in every mode: push, publish, deploy, force/destructive git, privilege escalation, broad deletes, piping downloads into a shell, dumping the environment, reading secret files. Writes are confined to the project (no secrets, dependencies, build output, `.git`, symlinks). Child processes get an environment without credential-like variables.
- Checkpoints: `/diff` shows all changes made by the agent; `/undo` reverts the last change set (skipping files you edited since).
- Loop safeguards: step limit, stop on repeated identical failing actions or four consecutive tool failures, cancellation with Ctrl-C, bounded history with older tool output shortened.
- `mia run <task>`: one agent task from the command line. Interactive session commands `/mode`, `/diff`, `/undo`, `/keys`.
- Several API keys per provider: `mia auth login <provider> --label <name>`, comma-separated keys in an environment variable. Mia Code stays on one key and switches automatically when it runs out of quota, is rate limited, is rejected, or the provider has an outage. Parked keys return after a cooldown; every switch is announced. `auth list` and `auth remove --label/--all` handle labels.
- "MIA CODE" startup banner with session details.

### Known limitations

- Tool calling depends on the model and endpoint; some OpenAI-compatible servers reject `tools` (use `/mode chat`).
- Undo covers only edits made through the edit/write tools, only for the current session; shell commands are not tracked.
- The command block list is a guardrail, not a sandbox. Use a container or VM for untrusted work.
- Key rotation switches before any output is streamed; an error in the middle of a reply is reported rather than retried on another key. Key state lives in memory for the session.
- Not yet verified against live providers; Anthropic and OpenAI wire formats are tested against mocks only.

## [0.2.0] - Unreleased

Phase 2: Repository intelligence. Still read-only: nothing edits files or runs project code.

### Added

- `mia scan`: repository map (languages, frameworks, inferred commands, directories, key modules, routes, environment variable names, test association), `--json` and `--full`.
- `mia search`: ripgrep-backed text search with a built-in fallback; `--symbol` for definitions; results limited to files the exclusion policy allows.
- `mia audit`: read-only static audit (modes quick, standard, deep, security, deployment, custom; text/json/markdown; `--fail-on`; `--output` refused inside the project). Findings carry confidence and how they were verified; the report lists what it cannot assess.
- Evidence-based answers: `ask` and the interactive session send line-numbered excerpts of the files most relevant to the question (shown before sending, secrets excluded, budgeted by `limits.evidenceChars` and the model's context window), then check `path:line` citations against what was sent. `--no-evidence`, `--show-context` extended.
- Safe file reader (no traversal, symlinks, excluded or binary files) and incremental index that re-reads only changed files.
- Session commands `/scan`, `/search`, `/audit`.

### Changed

- The project snapshot was replaced by the repository index and overview.

### Known limitations

- Symbols, imports and routes come from pattern matching, not parsers; relevance ranking is heuristic.
- The audit is static: no dependency vulnerability database, no runtime or performance analysis.
- Still no editing, command execution or test running.

## [0.1.0] - Unreleased

Phase 1: Foundation. Read-only chat assistant.

### Added

- CLI: `mia`, `ask`, `init`, `doctor`, `auth`, `provider`, `model`, `config`, `help`, `--version`.
- Interactive session with streaming replies, slash commands (`/help /status /context /usage /model /provider /clear /quit`), Ctrl-C cancellation.
- Configuration file with strict validation and atomic, owner-only writes; refuses to store API keys.
- Credential storage: Linux Secret Service (`secret-tool`), macOS Keychain (`security`), Windows DPAPI (PowerShell); environment-variable fallback.
- Provider abstraction with OpenAI-compatible and native Anthropic adapters; presets for OpenAI, Anthropic, OpenRouter, Groq, DeepSeek.
- Error normalisation, bounded retries with backoff, inactivity timeouts, redirect refusal.
- Project overview (file names + README start) with secret/dependency/binary exclusions and `.gitignore` support.
- Token usage reporting; cost estimates only from user-configured dated prices.
- Documentation, CI workflow (Ubuntu, Windows, macOS), issue and PR templates.

### Known limitations

- No file reading, editing, command execution, test running or git operations yet.
- Real providers, macOS Keychain and Windows DPAPI not yet verified on live systems.
- No saved sessions; no tool calling or structured output.
