# Releases

**Nothing has been published.** The package name `mia-code` has not been checked for availability or ownership on npm, and no binaries exist.

Before the first release a maintainer must:

1. Confirm the npm package name (or choose a scoped name such as `@miacodeai/mia-code`) and that the account has publish rights.
2. Confirm the licence decision and review dependency licences (`npm ls --all`; there are no runtime dependencies).
3. Verify on real systems: macOS Keychain, Windows DPAPI, Linux Secret Service, and each provider preset with a live key.
4. Run `npm run check` and the CI matrix; update `CHANGELOG.md`.
5. Publish with a protected token held in repository secrets (never in logs), using `npm publish --provenance` from CI.

Standalone binaries (Windows/Linux/macOS, x64/arm64) are planned for a later phase and must pass the platform tests before being published, with checksums.

## Versioning

Semantic versioning. Before 1.0, minor versions may change commands or config; changes are listed in `CHANGELOG.md` with migration notes.
The config file has a `version` field for future migrations.
