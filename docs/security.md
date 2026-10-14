# Security

## Threat model (this release)

| Threat                                           | Control                                                                                                                                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API key leaks into logs, errors, config, history | Central output redaction; config writer refuses key-shaped values; keys read without echo and removed from history                                                                                        |
| Key sent to the wrong host                       | https required (loopback excepted); redirects are never followed; preset env vars only used with the official URL                                                                                         |
| Key visible in the process list                  | Secrets go to helper programs (`secret-tool`, `security -i`, PowerShell) on **stdin**, never as arguments                                                                                                 |
| Secrets in the repository sent to the model      | `.env*`, keys, certificates, credential files, dependencies, build output, caches, binaries are never listed or read                                                                                      |
| Malicious repository content / prompt injection  | Only file **names** and the README start are sent, fenced as untrusted data in the system prompt; the model has no tools in this release, so injected instructions cannot read, write or execute anything |
| Hostile repository config executing code         | `git` runs with `core.fsmonitor=false`, no optional locks and no prompts; symlinks are never followed                                                                                                     |
| Malicious or buggy model output                  | Output is only printed. Nothing is executed or written                                                                                                                                                    |
| Compromised custom endpoint                      | You must confirm trust in the host before a key is requested; the key goes only to that host                                                                                                              |

## Coding agent controls

- Modes: `readonly`, `ask` (default), `auto-edit`, `auto`. Reading is always allowed; edits and commands follow the mode. Without a terminal, anything needing approval is declined.
- Blocked in every mode, including `auto`: git push/reset --hard/clean, publishing, deployment tooling, sudo, broad `rm`, piping downloads into a shell, disk tools, dumping environment variables, and reading or copying secret files.
- Edits are confined to the project and refuse secret files, dependency/build/VCS directories and symlinks. Child processes run without environment variables that look like credentials.
- Tool output and repository text are treated as untrusted data in the prompt, but a model can still be misled by hostile content in a repository. Review approvals, and use `ask` for code you do not trust.
- **The command block list is pattern matching, not a sandbox.** A model can phrase harmful commands in ways it will not match. Run untrusted work in a container or VM.
- Multiple API keys: keys are stored individually in the OS credential store (labels, not keys, are in the config file), only sent to the configured host, masked in output, and never passed to child commands.

## Honest limits

- **Redaction is best-effort pattern matching.** It masks known key shapes and every key Mia Code itself loaded, but cannot recognise every possible secret format.
  The project overview (file names and README start) is also redacted, but a secret placed in a README or a file name could still be sent. Review `/context`.
- Excluding files by name cannot catch secrets stored in ordinary-looking files. Excerpts sent with a question are redacted, and files containing private keys are skipped, but a secret embedded in ordinary source can still be sent; use `--show-context` to review, or `--no-evidence` to send none.
- The audit never prints secret values (token previews show a prefix and length only) and never writes inside the audited project.
- **Windows** stores keys with DPAPI scoped to your Windows user (not Credential Manager, which cannot be read back from a command line). Anyone who can run code as you can read them.
- Environment variables are visible to other processes of the same user on many systems.
- Application-level permissions are **not** an operating-system sandbox. When later phases add editing and command execution, stronger isolation
  (containers or OS sandboxes) will be offered as an option; a permission prompt alone should not be treated as a security boundary.
- The macOS and Windows credential backends and the live provider endpoints have not been verified on real systems yet (see the README).

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
