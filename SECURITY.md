# Security policy

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private vulnerability reporting for this repository ("Security" tab, "Report a vulnerability"). The maintainers should enable it
before the first public release; if it is not available, contact a maintainer privately through GitHub.

Include: affected version, what you did, what you expected, what happened, and the impact. Never include real API keys.

The maintainers aim to acknowledge reports promptly and to fix confirmed issues before disclosing them. (No formal response-time guarantee is made yet
for this early-stage project.)

## Scope of interest

API-key exposure (output, logs, config, process list, network), requests reaching an unintended host, exclusion-policy bypasses, unsafe subprocess
handling, and path or symlink handling. See [docs/security.md](docs/security.md) for the threat model and known limits.

## Supported versions

Only the latest release receives security fixes while the project is pre-1.0.
