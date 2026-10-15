# Roadmap

Status labels: **done** (implemented and tested), **next**, **planned**. Nothing marked planned exists yet.

| Phase | Theme                   | Status            | Contents                                                                                                                                             |
| ----- | ----------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Foundation              | **done (v0.1.0)** | CLI, config, credential storage, provider abstraction, OpenAI-compatible and Anthropic adapters, doctor, tests                                       |
| 2     | Repository intelligence | **done (v0.2.0)** | Language/framework detection, repository map, symbol and text search (ripgrep with fallback), evidence-based answers, read-only `mia audit`          |
| 3     | Controlled coding agent | **done (v0.3.0)** | Tool system with schemas and permissions, patch editing, shell tool, git tools, test runner, agent loop, diff review, undo                           |
| 4     | Hardening and workflow  | **done (v0.4.0)** | Symlink-safe writes, exact index freshness, OS sandbox, plan mode, `MIA.md`/`AGENTS.md`/skills, verify-and-repair, review, shell tracking, benchmark |
| 4b    | Advanced understanding  | **next**          | Symbol index, dependency mapping, session recovery                                                                                                   |
| 5     | More providers          | planned           | Additional native adapters (for example Gemini), capability detection, usage reporting, explicit fallback policy                                     |
| 6     | Community release       | planned           | Verified cross-platform behaviour, npm name check and publish, standalone binaries, licence review                                                   |
| 7     | Advanced capabilities   | planned           | Subagents, sandbox integrations, IDE integrations, routing                                                                                           |

## Planned, not implemented

**MCP integrations (GitHub, issue trackers).** Planned after the local workflow has proved reliable. Security notes: every MCP server is third-party code and its tool output is untrusted data; servers must be listed explicitly in config (never auto-discovered from a repository), start with read-only tools enabled, require per-tool approval for anything that writes (comments, issues, pull requests), run without the user's other credentials, and never receive the provider API keys.

**Isolated background tasks and git worktrees.** Planned after MCP. Each task would get its own worktree and sandbox, with no push or publish ever performed automatically, and a review step before anything is merged.

Also needed before a stable release: live verification of every provider preset, macOS/Windows credential backends, and a repeatable benchmark suite.
Mia Code will not claim to match or beat other agents until benchmarks support it.
