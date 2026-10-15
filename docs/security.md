# Security

## Threat model (v0.4)

| Threat                                           | Control                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API key leaks into logs, errors, config, history | Central output redaction; config writer refuses key-shaped values; keys read without echo and removed from history                                                                                                                                                                                                                     |
| Key sent to the wrong host                       | https required (loopback excepted); redirects are never followed; preset env vars only used with the official URL                                                                                                                                                                                                                      |
| Key visible in the process list                  | Secrets go to helper programs (`secret-tool`, `security -i`, PowerShell) on **stdin**, never as arguments                                                                                                                                                                                                                              |
| Secrets in the repository sent to the model      | `.env*`, keys, certificates, credential files, dependencies, build output, caches, binaries are never listed or read                                                                                                                                                                                                                   |
| Malicious repository content / prompt injection  | Repository text, tool output and instruction files are fenced as untrusted data. The model **does** have tools, so injected instructions are a real risk: writes are confined and revalidated, dangerous commands are blocked, edits and commands need approval in `ask`/`auto-edit`, and commands run in an OS sandbox when available |
| Hostile repository config executing code         | `git` runs with `core.fsmonitor=false`, no optional locks and no prompts; symlinks are never followed                                                                                                                                                                                                                                  |
| Malicious or buggy model output                  | Edits and commands go through permission modes, a block list, path checks and (for commands) the sandbox. Model output is never executed without passing those                                                                                                                                                                         |
| Compromised custom endpoint                      | You must confirm trust in the host before a key is requested; the key goes only to that host                                                                                                                                                                                                                                           |

## Sandbox (commands)

- Backends: bubblewrap on Linux (**tested**), Seatbelt via `sandbox-exec` on macOS and Docker on any OS (**generated arguments only; not run on real systems**). Windows has no built-in backend; use WSL2 or Docker.
- With bubblewrap: the file system is read-only, only the project (and `--allow-write` paths) is writable, `$HOME` is replaced by an empty temporary directory (SSH keys, cloud credentials and tokens are not visible), secret files in the project are masked, `/tmp` and process/IPC namespaces are private, capabilities are dropped, and the network is off unless you pass `--network`.
- `auto` mode refuses to start without a sandbox unless `--unsafe-no-sandbox` is given. Other modes warn when no sandbox is available.
- Not covered: the sandbox does not apply to Mia Code's own file tools (those use path checks and symlink-safe I/O), allowed network access is unrestricted, and a kernel or sandbox escape defeats it. File writes inside the project are by design allowed, so a command can still damage the project; use git and `/undo`.

## Coding agent controls

- Modes: `readonly`, `ask` (default), `auto-edit`, `auto`. Reading is always allowed; edits and commands follow the mode. Without a terminal, anything needing approval is declined.
- Blocked in every mode, including `auto`: git push/reset --hard/clean, publishing, deployment tooling, sudo, broad `rm`, piping downloads into a shell, disk tools, dumping environment variables, and reading or copying secret files.
- Edits are confined to the project and refuse secret files, dependency/build/VCS directories and symlinks. The path is revalidated at the moment of writing, using no-follow operations, so a symlink swapped in during review is refused (the anchoring is strongest on Linux; other platforms use a lstat plus post-open identity check). Undo uses the same checks.
- `MIA.md` / `AGENTS.md` / skills are guidance: they are fenced in the prompt and can never grant permissions, change the mode or disable approvals. Repository instruction files are untrusted when the repository is.
- Shell-made file changes are detected and listed; clean git-tracked files can be undone, others are only reported. Child processes run without environment variables that look like credentials.
- Tool output and repository text are treated as untrusted data in the prompt, but a model can still be misled by hostile content in a repository. Review approvals, and use `ask` for code you do not trust.
- **The command block list is pattern matching, not a sandbox** (the sandbox above is a separate control). A model can phrase harmful commands in ways it will not match. Run untrusted work in a container or VM.
- Multiple API keys: keys are stored individually in the OS credential store (labels, not keys, are in the config file), only sent to the configured host, masked in output, and never passed to child commands.

## Honest limits

- **Redaction is best-effort pattern matching.** It masks known key shapes and every key Mia Code itself loaded, but cannot recognise every possible secret format.
  The project overview (file names and README start) is also redacted, but a secret placed in a README or a file name could still be sent. Review `/context`.
- Excluding files by name cannot catch secrets stored in ordinary-looking files. Excerpts sent with a question are redacted, and files containing private keys are skipped, but a secret embedded in ordinary source can still be sent; use `--show-context` to review, or `--no-evidence` to send none.
- The audit never prints secret values (token previews show a prefix and length only) and never writes inside the audited project.
- **Windows** stores keys with DPAPI scoped to your Windows user (not Credential Manager, which cannot be read back from a command line). Anyone who can run code as you can read them.
- **Linux without a keyring:** with your consent, keys go in `credentials/` in the config directory (folder `0700`, files `0600`), **unencrypted**. Anyone who can read your files as you, or as root, can read them. Prefer a real keyring where you can.
- Environment variables are visible to other processes of the same user on many systems.
- Permission prompts are not a security boundary; the OS sandbox is, where available and verified.
- The macOS and Windows credential backends, the Seatbelt and Docker sandboxes and the live provider endpoints have not been verified on real systems yet ([docs/verification.md](verification.md)).
- Planned integrations (MCP servers, background tasks) are not implemented; see the roadmap notes before they are enabled.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
