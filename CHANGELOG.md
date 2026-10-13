# Changelog

All notable changes are documented here. Format based on Keep a Changelog; versioning is semantic.

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
