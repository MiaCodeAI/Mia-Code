# Troubleshooting

Start with `mia doctor` (add `--online` to test providers). Set `MIA_DEBUG=1` to see stack traces for unexpected errors.

| Problem                                          | What to do                                                                                                                                                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "No provider is configured"                      | Run `mia init`                                                                                                                                                                                      |
| "No API key found for …"                         | `mia auth login <name>`, or set the variable shown in the message                                                                                                                                   |
| "Secure credential storage is unavailable"       | Linux: install `libsecret-tools` and run a keyring (GNOME Keyring, KWallet), or accept the private key file when asked (`mia auth login <p> --file-store` in scripts), or use environment variables |
| Key accepted but chat fails with 404/model error | `mia model list`, then `mia model use <id>`                                                                                                                                                         |
| 401 after a working setup                        | Key revoked or expired; `mia auth login <name>`                                                                                                                                                     |
| TLS / certificate errors                         | Behind a proxy set `NODE_EXTRA_CA_CERTS=/path/ca.pem`. Do not disable verification                                                                                                                  |
| Config file is rejected                          | The message lists each problem; fix with `mia config edit`                                                                                                                                          |
| Editor does not open                             | Set `EDITOR` (for example `EDITOR=nano`)                                                                                                                                                            |
| Colours are wrong or unwanted                    | `NO_COLOR=1` disables colour; `FORCE_COLOR=1` enables it                                                                                                                                            |
| Hidden key entry does not work                   | Needs a real terminal; otherwise use `printf %s "$KEY" \| mia auth login <name> --stdin`                                                                                                            |
| Replies feel slow or are cut off                 | Raise `limits.requestTimeoutMs` / `limits.maxOutputTokens`; check `mia provider test`                                                                                                               |
| `mia: Permission denied` after `npm link`        | Rebuild (`npm run build` now sets the executable bit) or run `chmod +x dist/cli.js`                                                                                                                 |

Report bugs at <https://github.com/MiaCodeAI/Mia-Code/issues>. Never paste API keys; Mia Code masks them in its own output but your shell history may not.
