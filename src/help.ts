const MAIN = `Mia Code - open-source, bring-your-own-key AI coding assistant for the terminal.

Usage:
  mia                          Start an interactive session in the current folder
  mia ask <question>           Ask one question and print the answer
  mia run [--mode <mode>] <task>  Let the agent read, edit and test (asks before changing anything)
  mia scan [--json|--full]     Show a map of this project (local only)
  mia search <text>            Search project files (local only)
  mia audit [--mode <mode>]    Read-only static audit with a findings report
  mia init                     Guided setup: provider, API key, model, connectivity test
  mia doctor [--online]        Check this machine and your setup
  mia auth <login|list|remove> Manage API keys (several per provider with --label) (stored in your OS credential store)
  mia provider <list|add|test|use|remove>
  mia model <list|use>         List and select models
  mia config [show|path|edit]  View or edit the configuration file
  mia help [command]           Show help
  mia --version                Print the version

Mia Code maps, searches and audits your project, answers from the files most relevant to each
question, and can act as a coding agent: it edits files with a reviewable diff, runs your tests
and commands, and can undo its edits. Every change asks for approval unless you choose a more
permissive mode (readonly, ask, auto-edit, auto). Several API keys per provider rotate automatically.
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
  --no-context        Send only the question, no project overview or file excerpts
  --no-evidence       Send the overview but no file excerpts
  --show-context      Print the overview and the file excerpts that would be sent, then exit (sends nothing)

Excerpts are chosen locally (names in your question, symbols, text matches), never include
secret files, and are listed on stderr before sending. After the answer, any file:line citations
are checked against what was sent.`,

  run: `mia run [--mode readonly|ask|auto-edit|auto] [--max-steps <n>] [--diff] [--provider p] [--model m] <task>

Runs one agent task: it reads and searches the project, edits files, runs tests and commands, and
reports what it verified. Modes control approvals: readonly (no changes), ask (default: approve
each edit and command), auto-edit (edits applied, commands asked), auto (nothing asked; dangerous
commands such as push, publish, deploy, sudo and reading secrets are still blocked).
Without a terminal, actions that need approval are declined. File changes are tracked in this run
and shown with --diff. Use a container or VM for untrusted work: the safety blocks are a
guardrail, not a sandbox.`,

  scan: `mia scan [--json] [--full]

Maps the current project: languages, frameworks, detected commands, directories, key modules,
routes, environment variable names, tests and secret files present (names only). Heuristic,
local only, sends nothing. --full also lists every readable file path.`,

  search: `mia search [--regex] [--ignore-case] [--symbol] [--max <n>] <text>

Searches project files the exclusion policy allows (never secrets, dependencies or build output).
Uses ripgrep when installed, otherwise a built-in search. --symbol looks up definitions by name.
Exit code 1 when nothing matches.`,

  audit: `mia audit [--mode <mode>] [--categories <list>] [--format text|json|markdown]
          [--output <file>] [--fail-on <severity>]

Read-only static audit. Never changes project files, runs project code or uses the network.
Modes: quick, standard (default), deep, security, deployment, custom (needs --categories).
Categories: security, dependencies, deployment, testing, errors, maintainability, documentation,
crossplatform. Every finding states its confidence and how it was checked, and the report lists
what a static audit cannot assess. Add "mia-audit-ignore" to a line to suppress a finding there.
--output must be outside the project. --fail-on exits 1 when a finding of that severity or
worse exists (useful in CI). Performance audits are not supported.`,

  doctor: `mia doctor [--online] [--json]

Checks Node.js, the config file, secure key storage, git, terminal capabilities and each
configured provider's key. --online also contacts each provider with a model-list request.
Exit code is 1 if a blocking problem is found.`,

  auth: `mia auth login [provider] [--label <name>] [--stdin] [--no-validate]
mia auth list
mia auth remove <provider> [--label <name> | --all] [--yes]

login   Reads a key without echo (or from stdin with --stdin), checks it against the provider's
        own API, then stores it in your OS credential store (macOS Keychain, Linux Secret
        Service, Windows DPAPI). If no secure store exists, nothing is saved and you are shown
        how to use an environment variable instead. A rejected key is never stored.
        --label adds an extra key (for example a second account or a backup). With more than one key,
        Mia Code stays on one and automatically switches when it runs out of quota, is rate limited,
        is rejected, or the provider has an outage. Environment variables may hold several keys
        separated by commas.
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
