/**
 * Natural-language shortcuts for Mia Code's own commands. This is deliberately a small, deterministic,
 * local layer: it never calls a model and never decides anything on the user's behalf beyond running
 * the same command they could have typed ("undo" is exactly `/undo`). Everything it does not recognise
 * goes to the model as an ordinary request, which can use tools to act on it.
 */

export interface Routed {
  id: string;
  /** Equivalent slash command inside a session, or null when not applicable there. */
  slash: string | null;
  /** Equivalent `mia` arguments from the shell, or null when not applicable there. */
  cli: string[] | null;
  /** Text to show instead of running anything (used for things only a separate terminal can do). */
  say?: string;
  /** For `plan`: the task text. */
  task?: string;
}

const LEAD =
  /^(?:(?:hey|hi|hello|ok|okay|so|now|then|just|please|pls|kindly|mia|mia code)[,:]?\s+|(?:can|could|would|will) you(?: please)?\s+|i (?:want|need|would like|wanna|'d like) (?:you )?to\s+|i(?:'d| would) like (?:you )?(?:to )?|i want\s+|i need you to\s+|let'?s\s+|go ahead and\s+)+/;
const TRAIL = /\s+(?:please|pls|for me|now|thanks|thank you|right now|again)$/;

export function normalize(text: string): string {
  let t = text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?,;:\s]+$/, '');
  for (let i = 0; i < 4; i++) {
    const next = t.replace(LEAD, '').replace(TRAIL, '').trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

const MODE_WORDS: Record<string, string> = {
  chat: 'chat',
  'read only': 'readonly',
  'read-only': 'readonly',
  readonly: 'readonly',
  ask: 'ask',
  approval: 'ask',
  'auto edit': 'auto-edit',
  'auto-edit': 'auto-edit',
  autoedit: 'auto-edit',
  auto: 'auto',
  'full auto': 'auto',
  autonomous: 'auto',
};

const THE = '(?:(?:the|this|my|our|current|whole|entire)\\s+)*';
const TARGET = `${THE}(?:project|repo|repository|codebase|code base|code|folder|directory)`;
const MODE_NAME =
  '(chat|read[- ]?only|readonly|ask|approval|auto[- ]?edit|full auto|autonomous|auto)';
const MODEL_ID = '([\\w][\\w.:/-]*)';

function looksLikeModelId(id: string): boolean {
  return /[\d:/-]/.test(id);
}

export function routeIntent(input: string): Routed | null {
  const t = normalize(input);
  if (t === '' || t.length > 140 || t.startsWith('/')) return null;
  let m: RegExpExecArray | null;

  if (
    /^(?:exit|quit|bye|goodbye|good bye|i'?m done|that'?s all|close|leave|end(?: the)? session|stop mia)$/.test(
      t,
    )
  )
    return { id: 'quit', slash: '/quit', cli: null };

  if (
    /^(?:help|commands|what can you do|what are (?:the )?commands|what commands(?: are there| do you have)?|how do i use (?:this|mia|mia code)|show (?:the )?(?:help|commands)|list (?:the )?commands)$/.test(
      t,
    )
  )
    return { id: 'help', slash: '/help', cli: ['help'] };

  if (
    /^(?:clear(?: (?:the )?(?:chat|conversation|history|context))?|reset(?: (?:the )?(?:chat|conversation))?|start over|new (?:chat|conversation|session)|forget (?:everything|this|the conversation|our conversation))$/.test(
      t,
    )
  )
    return { id: 'clear', slash: '/clear', cli: null };

  if (
    /^(?:undo|undo (?:that|it|this|the last (?:changes?|edits?)|last (?:changes?|edits?)|your (?:last )?(?:changes?|edits?))|revert (?:that|it|the last (?:changes?|edits?)|your (?:last )?(?:changes?|edits?))|roll ?back(?: (?:that|it|the last (?:changes?|edits?)|your (?:last )?(?:changes?|edits?)))?|take (?:that|it) back)$/.test(
      t,
    )
  )
    return { id: 'undo', slash: '/undo', cli: null };

  if (
    /^(?:diff|show (?:me )?(?:the )?(?:diff|changes|what (?:you )?changed)|what (?:did you|have you) (?:change|changed|do|done|edit|edited)|what (?:has |have )?changed|(?:list|show) (?:me )?(?:the )?(?:changed|modified) files|show (?:me )?(?:your )?(?:changes|edits))$/.test(
      t,
    )
  )
    return { id: 'diff', slash: '/diff', cli: null };

  // Security-flavoured checks first so "check the code for vulnerabilities" is an audit.
  if (
    new RegExp(
      `^(?:check|scan|look|search)(?: ${TARGET})? for (?:security (?:issues|problems|holes|vulnerabilities|risks|flaws)|vulnerabilities|secrets|leaked (?:keys|secrets|credentials))$`,
    ).test(t)
  )
    return { id: 'audit', slash: '/audit --mode security', cli: ['audit', '--mode', 'security'] };
  if (
    (m = new RegExp(
      `^(?:(?:run|do|perform|start|give me|make)(?: an?| the)? )?(?:(security|quick|deep|standard|deployment) )?audit(?: (?:of )?${TARGET})?$`,
    ).exec(t))
  ) {
    const mode = m[1];
    return {
      id: 'audit',
      slash: `/audit${mode ? ` --mode ${mode}` : ''}`,
      cli: ['audit', ...(mode ? ['--mode', mode] : [])],
    };
  }

  if (
    new RegExp(
      `^(?:scan|map)(?: out)?(?: ${TARGET})?(?: structure)?$|^(?:show|give|display|print|list)(?: me)? ${THE}(?:project|repo|repository|codebase)?\\s?(?:map|structure|overview|layout|tree)$|^${THE}(?:project|repo|repository|codebase) (?:map|structure|overview|layout|tree)$`,
    ).test(t)
  )
    return { id: 'scan', slash: '/scan', cli: ['scan'] };

  if (
    /^(?:doctor|diagnose(?: (?:my )?(?:setup|install(?:ation)?))?|check (?:my |the )?(?:setup|install(?:ation)?|config(?:uration)?)|is (?:everything|it|mia) (?:set ?up|working|ok|okay|installed|configured)(?: (?:correctly|properly|right))?|health check)$/.test(
      t,
    )
  )
    return { id: 'doctor', slash: '/doctor', cli: ['doctor'] };

  if (
    /^(?:set ?up|setup|configure|initiali[sz]e|get started|add (?:an? )?(?:new )?(?:ai )?(?:provider|api key|key)|connect (?:to )?(?:an? )?(?:provider|ai|openai|anthropic|groq|openrouter|deepseek)|log ?in)$/.test(
      t,
    )
  )
    return {
      id: 'setup',
      slash: null,
      cli: ['init'],
      say: 'Setup needs its own terminal prompts. Run "mia init" to connect a provider, or "mia auth login <provider> --label <name>" to add another key. Keys are never typed into this chat.',
    };

  if (
    (m = new RegExp(
      `^(?:switch|change|set|go|turn|put)(?: (?:it|mia|me|this))?(?: back)?(?: (?:to|into|in))? ${MODE_NAME}(?: mode)?$|^(?:use|enable|enter|start in|be in) ${MODE_NAME} mode$|^${MODE_NAME} mode$`,
    ).exec(t))
  ) {
    const word = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\s+/g, ' ');
    const mode =
      MODE_WORDS[word] ??
      MODE_WORDS[word.replace(/\s/g, '-')] ??
      MODE_WORDS[word.replace(/[- ]/g, '')];
    if (mode) return { id: 'mode', slash: `/mode ${mode}`, cli: null };
  }
  if (
    /^(?:what|which) mode (?:am i|are we|is (?:this|it)) (?:in|using|on)|^(?:show |current )(?:the )?(?:current )?mode$/.test(
      t,
    )
  )
    return { id: 'mode-show', slash: '/mode', cli: null };
  if (/^make it read[- ]?only$/.test(t)) return { id: 'mode', slash: '/mode readonly', cli: null };

  if (
    /^(?:(?:list|show|what|which)(?: me)?(?: (?:all|the|available|my))* models(?: (?:are )?(?:available|can i use|do i have|i can use|are there))?|what models (?:are there|can i use|do i have|are available))$/.test(
      t,
    )
  )
    return { id: 'models', slash: '/models', cli: ['model', 'list'] };
  if (
    /^(?:(?:what|which) (?:ai )?model (?:am i|are we|is (?:this|it)) (?:using|on|running)|(?:show|current) (?:the )?(?:current )?model)$/.test(
      t,
    )
  )
    return { id: 'model-show', slash: '/model', cli: null };
  if (
    (m = new RegExp(
      `^(?:(?:use|switch to|change to|try|set) (?:the )?model ${MODEL_ID}|(?:change|switch|set) (?:the |my )?model (?:to )?${MODEL_ID}|(?:use|switch to|try) ${MODEL_ID} model)$`,
    ).exec(t))
  ) {
    const id = m[1] ?? m[2] ?? m[3];
    if (id && looksLikeModelId(id)) return { id: 'model', slash: `/model ${id}`, cli: null };
  }

  if (
    /^(?:list|show)(?: me)?(?: (?:the|my|all|configured))* providers$|^(?:what|which) providers (?:do i have|are (?:there|configured))$/.test(
      t,
    )
  )
    return { id: 'providers', slash: '/provider', cli: ['provider', 'list'] };
  if (
    (m = /^(?:switch|change|use|set)(?: (?:the|my))? provider (?:to )?([a-z0-9][a-z0-9_-]*)$/.exec(
      t,
    ))
  )
    return { id: 'provider', slash: `/provider ${m[1]}`, cli: null };

  if (/^(?:retry|reset|unpark) (?:my |the |all )?(?:api )?keys$/.test(t))
    return { id: 'keys-reset', slash: '/keys reset', cli: null };
  if (
    /^(?:(?:show|list|check)(?: me)?(?: (?:my|the))*(?: api)? keys(?: status)?|(?:are|how are) my (?:api )?keys(?: (?:ok|okay|working|fine|doing))?|key status)$/.test(
      t,
    )
  )
    return { id: 'keys', slash: '/keys', cli: ['auth', 'list'] };

  if (
    /^(?:(?:show|check|what(?:'s| is))(?: me)?(?: (?:my|the))*(?: token)? (?:usage|cost|spend(?:ing)?|tokens(?: used)?)|usage|cost|how many tokens(?: (?:have i|did i|i have) used| used| so far)?|how much (?:have i spent|did (?:that|this) cost|is this costing(?: me)?))$/.test(
      t,
    )
  )
    return { id: 'usage', slash: '/usage', cli: null };

  if (
    /^(?:status|session status|where am i|(?:what|which) provider (?:am i|are we) (?:using|on)|show (?:me )?(?:the )?(?:session |current )?(?:status|settings)|what(?:'s| is) (?:my |the )?(?:current )?(?:status|setup))$/.test(
      t,
    )
  )
    return { id: 'status', slash: '/status', cli: null };

  if (
    /^(?:show (?:me )?(?:the )?context|what (?:are you|do you|is being|gets) (?:sending|send|sent)(?: to (?:the )?(?:ai|provider|model))?)$/.test(
      t,
    )
  )
    return { id: 'context', slash: '/context', cli: null };

  if (
    /^(?:(?:list|show|what)(?: me)?(?: (?:the|all|available|your))* skills(?: (?:are )?(?:available|do you have|can you use))?|what skills(?: are there)?)$/.test(
      t,
    )
  )
    return { id: 'skills', slash: '/skills', cli: null };
  if (
    /^(?:show|list|what)(?: me)?(?: (?:the|my|project))* (?:instructions|mia\.md|agents\.md)(?: (?:are )?(?:applied|loaded|in use))?$/.test(
      t,
    )
  )
    return { id: 'instructions', slash: '/instructions', cli: null };
  if (
    (m =
      /^(?:use|run|apply|load) (?:the )?([a-z0-9][a-z0-9-]*) skill(?: (?:to|on|for) (.+))?$/.exec(
        t,
      ))
  )
    return { id: 'skill', slash: `/skill ${m[1]}${m[2] ? ` ${m[2]}` : ''}`, cli: null };

  if (
    (m =
      /^(?:(?:make|create|write|draft|give me|come up with)(?: me)? an? plan (?:for|to) (.+)|plan (?:out )?(.+) first)$/.exec(
        input
          .trim()
          .replace(/[.!?]+$/, '')
          .replace(LEAD, '')
          .replace(/^./, (c) => c.toLowerCase()),
      ))
  ) {
    const task = (m[1] ?? m[2] ?? '').trim();
    if (task) return { id: 'plan', slash: `/plan ${task}`, cli: ['run', '--plan', task], task };
  }
  return null;
}
