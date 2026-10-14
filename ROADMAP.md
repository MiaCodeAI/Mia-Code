# Roadmap

Status labels: **done** (implemented and tested), **next**, **planned**. Nothing marked planned exists yet.

| Phase | Theme                   | Status            | Contents                                                                                                                                    |
| ----- | ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Foundation              | **done (v0.1.0)** | CLI, config, credential storage, provider abstraction, OpenAI-compatible and Anthropic adapters, doctor, tests                              |
| 2     | Repository intelligence | **done (v0.2.0)** | Language/framework detection, repository map, symbol and text search (ripgrep with fallback), evidence-based answers, read-only `mia audit` |
| 3     | Controlled coding agent | **done (v0.3.0)** | Tool system with schemas and permissions, patch editing, shell tool, git tools, test runner, agent loop, diff review, undo                  |
| 4     | Advanced understanding  | **next**          | Symbol index, dependency mapping, `MIA.md`, session recovery, repeated-failure detection                                                    |
| 5     | More providers          | planned           | Additional native adapters (for example Gemini), capability detection, usage reporting, explicit fallback policy                            |
| 6     | Community release       | planned           | Verified cross-platform behaviour, npm name check and publish, standalone binaries, licence review                                          |
| 7     | Advanced capabilities   | planned           | Subagents, sandbox integrations, IDE integrations, routing                                                                                  |

Also needed before a stable release: live verification of every provider preset, macOS/Windows credential backends, and a repeatable benchmark suite.
Mia Code will not claim to match or beat other agents until benchmarks support it.
