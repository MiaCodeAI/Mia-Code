# Getting started

## 1. Requirements

- Node.js 20 or newer (`node --version`).
- An API key from a supported provider (you pay the provider directly; Mia Code is free).
- Optional: `git` (branch and change info), a Secret Service keyring on Linux (`libsecret-tools`) for encrypted key storage (otherwise the private key file fallback is offered).

## 2. Install from source

```bash
git clone https://github.com/MiaCodeAI/Mia-Code.git
cd Mia-Code
npm install
npm run build
npm link
```

## 3. Connect a provider

```bash
mia init
```

The wizard explains the bring-your-own-key model, shows the provider's official documentation link, reads your key **without echoing it**,
validates it against the provider, stores it in your OS credential store, lets you pick a model, and offers a tiny connectivity test.

If no secure store is available (for example a Linux server, container or minimal desktop without a keyring), Mia Code explains why and offers a **private key file** in your config directory (`credentials/`, folder `0700`, file `0600`). It is readable only by your user account but is **not encrypted**, and it is only used after you agree (or pass `--file-store`). If you decline, the key is not saved and you are shown how to supply it through an environment variable instead.

## 4. Use it

```bash
cd your-project
mia                       # interactive
mia ask "What does this project do?"
```

In a session, `/context` shows exactly what project information is sent to the model.

## 5. Check your setup

```bash
mia doctor            # local checks
mia doctor --online   # also contacts each configured provider
```

## Where files live

| Platform | Config                                                   |
| -------- | -------------------------------------------------------- |
| Linux    | `~/.config/mia-code/config.json` (or `$XDG_CONFIG_HOME`) |
| macOS    | `~/Library/Application Support/mia-code/config.json`     |
| Windows  | `%APPDATA%\mia-code\config.json`                         |

Override with `MIA_CONFIG_DIR`. Run `mia config path` to print the exact location. The config never contains API keys.

## Cost control

Token counts are shown after each reply when the provider reports them. To see cost estimates, add a **dated** price to the config
(Mia Code never ships prices because they go stale):

```json
{
  "pricing": {
    "openai/<model-id>": {
      "inputPerMTok": 1.0,
      "outputPerMTok": 2.0,
      "asOf": "2026-01-31",
      "currency": "USD"
    }
  }
}
```

Other limits live under `limits` (`requestTimeoutMs`, `maxOutputTokens`, `maxRetries`). Mia Code never switches provider or model on its own
when a limit or quota is hit.
