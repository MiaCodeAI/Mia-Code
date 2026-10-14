# Changelog

All notable changes are documented here. Format based on Keep a Changelog; versioning is semantic.

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
