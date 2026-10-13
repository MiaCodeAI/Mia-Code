const MAIN = `Mia Code - open-source, bring-your-own-key AI coding assistant for the terminal.

Usage:
  mia                          Start an interactive session in the current folder
  mia ask <question>           Ask one question and print the answer
  mia init                     Guided setup: provider, API key, model, connectivity test
  mia doctor [--online]        Check this machine and your setup
  mia auth <login|list|remove> Manage API keys (stored in your OS credential store)
  mia provider <list|add|test|use|remove>
  mia model <list|use>         List and select models
  mia config [show|path|edit]  View or edit the configuration file
  mia help [command]           Show help
  mia --version                Print the version

Current status: this release is read-only chat. It can see a file-name overview of your
project (and the start of your README) but cannot yet read files, edit code or run commands.
Run "mia help <command>" for details, and see docs/ for guides.`;

const TOPICS: Record<string, string> = {
  init: `mia init

Interactive setup. Explains the bring-your-own-key model, lets you pick a provider (or a
custom endpoint), reads your API key without echoing it, validates it with the provider,
stores it in your OS credential store, helps you choose a model and runs a small test.
Requires a terminal. For scripts use "mia provider add", "mia auth login --stdin", "mia model use".`,

  ask: `mia ask [options] <question>

Sends one question (plus a file-name overview of the current project) and streams the answer.
The answer goes to stdout; notices and token usage go to stderr, so it is safe to pipe.

Options:
  --provider <name>   Use this provider instead of the default
  --model <id>        Use this model instead of the provider's selected model
  --no-context        Send only the question, no project overview
  --show-context      Print the project overview that would be sent, then exit (sends nothing)`,

  doctor: `mia doctor [--online] [--json]

Checks Node.js, the config file, secure key storage, git, terminal capabilities and each
configured provider's key. --online also contacts each provider with a model-list request.
Exit code is 1 if a blocking problem is found.`,

  auth: `mia auth login [provider] [--stdin] [--no-validate]
mia auth list
mia auth remove <provider> [--yes]

login   Reads a key without echo (or from stdin with --stdin), checks it against the provider's
        own API, then stores it in your OS credential store (macOS Keychain, Linux Secret
        Service, Windows DPAPI). If no secure store exists, nothing is saved and you are shown
        how to use an environment variable instead. A rejected key is never stored.
list    Shows each provider and where its key was found. Keys are never displayed.
remove  Deletes the stored key for a provider.`,

  provider: `mia provider list
mia provider add [--preset <id> | --kind <openai-compatible|anthropic> --base-url <url>]
                 [--name <name>] [--model <id>] [--api-key-env <VAR>]
                 [--max-tokens-param <max_tokens|max_completion_tokens>] [--use] [--force]
mia provider test [name]
mia provider use <name>
mia provider remove <name> [--yes]

Presets: openai, anthropic, openrouter, groq, deepseek. Any other service that speaks the
OpenAI chat format can be added with --kind and --base-url. Base URLs must use https
(plain http is allowed only for localhost). "test" sends one tiny prompt (a few tokens).`,

  model: `mia model list [provider] [--filter <text>]
mia model use <model> [--provider <name>]

list  Asks the provider which models your key can use (needs a working key).
use   Selects the model for a provider. The name is checked on the first request.`,

  config: `mia config [show|path|edit]

show   Prints the configuration (default). It never contains API keys.
path   Prints the location of the config file.
edit   Opens the file in $VISUAL / $EDITOR (notepad on Windows, vi elsewhere), then validates it.

The location can be overridden with the MIA_CONFIG_DIR environment variable.`,
};

export function mainHelp(): string {
  return MAIN;
}

export function topicHelp(topic: string): string | undefined {
  return TOPICS[topic];
}

export function helpTopics(): string[] {
  return Object.keys(TOPICS);
}
