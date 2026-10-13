# Adding a provider

## A service that speaks the OpenAI chat format

Usually no code is needed:

```bash
mia provider add --name acme --kind openai-compatible --base-url https://api.acme.example/v1 --api-key-env ACME_KEY
```

To offer it as a built-in preset, add an entry to `PRESETS` in `src/providers/registry.ts` with its **official** base URL, documentation link and key variable,
then document it in `docs/providers.md` as _implemented, awaiting live verification_ until someone has run it with a real key.

## A service with a different API

1. Create `src/providers/<name>.ts` implementing `Provider` (`listModels`, `streamChat`). Reuse `RequestScope`, `sendRequest`, `readJson`, `parseSse`,
   `streamWithRetry` and `withRetry`; do not call `fetch` directly (that would bypass the redirect and timeout rules).
2. Map every failure to `ProviderError` (see `errors.ts`). Never include request headers or keys in messages.
3. Add the new `kind` to `ProviderKind` and `validateProvider` in `src/config/schema.ts`, and to `createProvider` in the registry.
4. Write mocked tests in `tests/providers.test.ts` style: streaming text, usage, mid-stream errors, auth failure (no retry), rate limit (retry),
   truncated stream, and a check that the key appears only in the intended header.
5. Update `docs/providers.md`. Do not claim live support without a recorded live check.
