# Providers

## Adapters

| Adapter             | Used for                                                   | Verified how                                                    |
| ------------------- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| `openai-compatible` | Any service implementing `/chat/completions` and `/models` | Mocked HTTP tests and a local mock server. **Not** live-tested. |
| `anthropic`         | Anthropic Messages API (`/v1/messages`, `/v1/models`)      | Mocked HTTP tests. **Not** live-tested.                         |

"Supported" in this project means an adapter exists **and** has been tested. Today that testing is against mocks, so treat each real
provider as _implemented, awaiting live verification_ until the table in this file says otherwise. Contributions that run the opt-in live
checks with their own key and record the result are welcome.

## Presets

Presets only fill in a base URL, the key-issuing documentation link and the conventional environment variable. They were written from
provider documentation and have **not** been exercised against the live services.

| Preset       | Base URL                         | Key variable         |
| ------------ | -------------------------------- | -------------------- |
| `openai`     | `https://api.openai.com/v1`      | `OPENAI_API_KEY`     |
| `anthropic`  | `https://api.anthropic.com`      | `ANTHROPIC_API_KEY`  |
| `openrouter` | `https://openrouter.ai/api/v1`   | `OPENROUTER_API_KEY` |
| `groq`       | `https://api.groq.com/openai/v1` | `GROQ_API_KEY`       |
| `deepseek`   | `https://api.deepseek.com`       | `DEEPSEEK_API_KEY`   |

The spec also names Gemini, Mistral, xAI, Qwen, GLM, Kimi, MiniMax, Together, Fireworks, Cerebras and SiliconFlow. Several offer
OpenAI-compatible endpoints you can add today as a custom provider; they are **not** presets because their URLs and behaviours have
not been verified here. Gemini would likely need its own native adapter.

## Custom endpoints

```bash
mia provider add --name mine --kind openai-compatible --base-url https://llm.example.com/v1 --api-key-env MY_LLM_KEY
```

- URLs must be `https://`; plain `http://` is accepted only for loopback (`localhost`, `127.x`, `::1`) so local servers such as Ollama work.
- URLs may not contain credentials, query strings or fragments.
- Some endpoints expect `max_completion_tokens` instead of `max_tokens`: use `--max-tokens-param max_completion_tokens`.
- Loopback endpoints do not require a key.

## A key is only sent where you configured it

A preset's standard environment variable (for example `OPENAI_API_KEY`) is used **only while the endpoint is that preset's official URL**.
If you change the base URL, that variable is ignored unless you set `apiKeyEnv` yourself, so a key issued by one company is not
silently sent to another host.

## Capabilities

Mia Code does not infer capabilities from model names. `mia model use` and `/status` show each capability as _unknown_ unless the provider's model
list reports it (currently only context window, where offered) or you declare it in the config:

```json
{
  "capabilities": {
    "openai/*": { "streaming": true },
    "openai/<model-id>": {
      "contextWindow": 128000,
      "tools": true,
      "notes": "from provider docs, checked 2026-01-31"
    }
  }
}
```

## Errors you may see

| Message                     | Meaning and fix                                                        |
| --------------------------- | ---------------------------------------------------------------------- |
| Authentication failed (401) | Wrong key, or a key from a different provider. `mia auth login <name>` |
| Access denied (403)         | The key lacks access to the model, organisation or region              |
| Out of quota or credit      | Billing or limits at the provider; no automatic switching occurs       |
| Rate limited (429)          | Retried with backoff (honouring `Retry-After` up to 30 s)              |
| Model not found (404)       | `mia model list`, then `mia model use <id>`                            |
| Request too large           | `/clear`, or choose a model with a larger context window               |
| TLS certificate failed      | Corporate proxy? Set `NODE_EXTRA_CA_CERTS`. Never disable verification |
