# Contributing to Mia Code

Thank you for helping. Mia Code is a community project; the goal is a trustworthy, extensible, open-source coding agent.

## Setup

```bash
git clone https://github.com/MiaCodeAI/Mia-Code.git
cd Mia-Code
npm install
npm run check      # format check, lint, typecheck, tests
```

Node.js 20+ is required. **You never need a paid API key**: tests use mocked providers.

## Standards

- TypeScript strict mode; explicit types at module boundaries. Prefer small modules with clear interfaces.
- No new runtime dependency without a discussion in an issue (supply-chain and licence cost). Dev dependencies should be justified in the PR.
- Format with Prettier (`npm run format`), lint with ESLint. CI enforces both.
- Never put secrets in code, tests, logs or fixtures. Test keys must be obviously fake.
- Handle errors and cancellation. Never print or log an API key, and keep key redaction paths intact.
- Respect Windows, Linux and macOS differences; do not assume a Unix shell. Use argument lists, never shell strings, for subprocesses.
- **Do not claim a feature or provider works unless it does.** Documentation must match behaviour, and unfinished things are labelled as such.

## Tests and documentation

Every behaviour change needs tests, and every user-visible change needs documentation (`README.md`, `docs/`, `CHANGELOG.md`).
Security-relevant code (redaction, endpoints, credentials, exclusions, subprocess handling) requires tests for both the allowed and the refused case.

## Pull requests

1. Open an issue for anything non-trivial first.
2. Keep PRs focused; describe what changed, how you tested it, and any limitations.
3. CI (Ubuntu, Windows, macOS) must pass. At least one maintainer review is required for merging; changes to security-relevant areas need a second look.

## Releases

Maintainers follow [docs/releases.md](docs/releases.md). Contributors do not publish packages.

## Conduct and security

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public issues.
