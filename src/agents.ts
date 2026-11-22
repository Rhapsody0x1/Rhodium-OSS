// The agents Rhodium runs, one row each (architecture §6.1). What differs by agent outside its driver
// is read from here, or from a Record<AgentKind, …> beside the code that needs it: the driver
// (runner.ts), the transcript format (transcript.ts), the terminal's launch (tui.ts), the settings
// carried back from it (router.ts), the logo and the tool names (web/). A kind missing from any of
// them does not compile. No imports but types: every rh call and the board's page load this.
import type { AgentKind, BuiltinAgentKind, CommonCommand } from "./contracts";

export type AgentDef = {
  name: string; // as Rhodium's own words call it: Claude, pi
  statusName: string; // /status's Agent： line (docs/im-style.md §7.1)
  program: string; // [programs]' default: a bare name, looked up on PATH
  // --session-id opens the session if there is one, else starts it under that id (pi, architecture
  // §6.3). Otherwise only a conversation the agent wrote down is resumed; one it never did starts
  // under its id (Claude, §6.2).
  sessionIdOpens: boolean;
  // Switches the approval mode in the running process: at once, or from its next turn on (Codex, §6.4);
  // false: a restart once idle (§6.3).
  liveApproval: "now" | "next turn" | false;
  ultracode: boolean; // takes /ultracode
  apiPrice: boolean; // its cost is what the tokens would cost at API prices, not what you pay (story 396)
  modelNames: boolean; // names its models, Claude in its handshake, Codex in model/list, which the store keeps (store's modelNames)
  paneImport: boolean; // rh import takes a Herdr pane it runs in, named after the kind (product §4.3)
  claudeKeys: boolean; // may have Claude's keys and subscription; no other agent may (product §12)
  builtin: boolean; // true only for the three built-in drivers
  tui: boolean; // whether rh tui / Herdr terminal switching is supported
  importable: boolean; // whether rh import scans local disk transcripts
  steer: boolean; // whether running turns accept mid-turn messages without queuing AFTER_TURN
  supportedCommands: readonly CommonCommand[] | null; // null means all built-in commands (subject to ultracode)
};

export const AGENTS: Record<BuiltinAgentKind, AgentDef> = {
  claude: {
    name: "Claude",
    statusName: "Claude Code",
    program: "claude",
    sessionIdOpens: false,
    liveApproval: "now",
    ultracode: true,
    apiPrice: true,
    modelNames: true,
    paneImport: true,
    claudeKeys: true,
    builtin: true,
    tui: true,
    importable: true,
    steer: true,
    supportedCommands: null,
  },
  pi: {
    name: "pi",
    statusName: "Pi",
    program: "pi",
    sessionIdOpens: true,
    liveApproval: false,
    ultracode: false,
    apiPrice: false,
    modelNames: false,
    paneImport: true,
    claudeKeys: false,
    builtin: true,
    tui: true,
    importable: true,
    steer: true,
    supportedCommands: null,
  },
  codex: {
    name: "Codex",
    statusName: "Codex CLI",
    program: "codex",
    sessionIdOpens: false,
    liveApproval: "next turn",
    ultracode: false,
    apiPrice: false,
    modelNames: true,
    paneImport: false,
    claudeKeys: false,
    builtin: true,
    tui: true,
    importable: true,
    steer: true,
    supportedCommands: null,
  },
};

export const AGENT_KINDS = Object.keys(AGENTS) as BuiltinAgentKind[];
/** The agent of a slot made without one, and the one the /resume list and rh ls leave unmarked. */
export const DEFAULT_AGENT: BuiltinAgentKind = "claude";

const pluginAgents = new Map<string, AgentDef>();

/** Register a non-builtin agent plugin capability descriptor (enforcing sandbox/non-builtin invariants). */
export function registerAgentPlugin(
  id: string,
  def: Partial<AgentDef> & Pick<AgentDef, "name" | "statusName">,
): void {
  if (isBuiltinAgent(id)) throw new Error(`cannot override builtin agent ${id}`);
  pluginAgents.set(id, {
    name: def.name,
    statusName: def.statusName,
    program: def.program || id,
    sessionIdOpens: false,
    liveApproval: def.liveApproval === "now" || def.liveApproval === "next turn" ? def.liveApproval : false,
    ultracode: false,
    apiPrice: false,
    modelNames: Boolean(def.modelNames),
    paneImport: false,
    claudeKeys: false,
    builtin: false,
    tui: false,
    importable: Boolean(def.importable),
    steer: Boolean(def.steer),
    supportedCommands: def.supportedCommands ? [...def.supportedCommands] : [],
  });
}

export function unregisterAgentPlugin(id: string): void {
  pluginAgents.delete(id);
}

export function resetAgentPlugins(): void {
  pluginAgents.clear();
}

export function isBuiltinAgent(kind: string): kind is BuiltinAgentKind {
  return Object.hasOwn(AGENTS, kind);
}

export function isRegisteredAgent(kind: string): boolean {
  return isBuiltinAgent(kind) || pluginAgents.has(kind);
}

export function allAgentKinds(): AgentKind[] {
  return [...AGENT_KINDS, ...pluginAgents.keys()];
}

const FALLBACK_AGENT: Omit<AgentDef, "name" | "statusName" | "program"> = {
  sessionIdOpens: false,
  liveApproval: false,
  ultracode: false,
  apiPrice: false,
  modelNames: false,
  paneImport: false,
  claudeKeys: false,
  builtin: false,
  tui: false,
  importable: false,
  steer: false,
  supportedCommands: [],
};

/** Resolve an agent definition across built-ins, loaded plugins, or a safe non-builtin fallback. */
export function agentDef(kind: AgentKind): AgentDef {
  if (isBuiltinAgent(kind)) return AGENTS[kind];
  return pluginAgents.get(kind) ?? { name: kind, statusName: kind, program: kind, ...FALLBACK_AGENT };
}

/** By agent, whether Rhodium types what comes for it into its terminal (architecture §10.5); busy: also
 *  while Herdr says it works, as Claude takes it into the turn; runs: what of yours from the board led by
 *  / or ! it types bare, as a command the agent runs, which tui.ts knows on screen and in the transcript
 *  (#737 probes: Claude's / and !, pi's /skill: and !; Codex could not be probed). One not here is never
 *  typed into: what comes for it waits for the switch back. Its screen rule and its trace are in tui.ts. */
export const TYPING: Partial<Record<AgentKind, { busy: boolean; runs?: RegExp }>> = {
  claude: { busy: true, runs: /^(?:\/[^\s/]|!\s*\S)/ },
  codex: { busy: true },
  pi: { busy: true, runs: /^(?:\/skill:\S|!\s*\S)/ },
};

// Variables a parent Claude or Codex session or Herdr pane hands down (architecture §6.2, §6.4). Left
// in, a user Herdr hook or extension would report the headless process as that pane's agent. The
// Claude session ones have many names that change between versions, so every CLAUDE_CODE_ variable
// goes, settings a caller passes on purpose (CLAUDE_CODE_MAX_OUTPUT_TOKENS...) included. Kept: the
// crash-resume switch (architecture §4.8), which the runner sets. Codex's are those codex-cli 0.162.1
// gives its commands (start-mid-turn); CODEX_HOME and its other settings stay.
const PARENT_SESSION =
  /^(CLAUDECODE|CLAUDE_CODE_(?!RESUME_INTERRUPTED_TURN$).*|CLAUDE_PID|CLAUDE_EFFORT|CODEX_(THREAD_ID|SESSION_ID|CI|VERSION|APPLY_PATCH_PRESERVE_LINE_ENDINGS)|AI_AGENT|HERDR_.*)$/;
// Claude's keys and subscription, ANTHROPIC_API_KEY, ANTHROPIC_OAUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN
// and the like: only for an agent with claudeKeys (product §12).
const CLAUDE_KEYS = /^(ANTHROPIC_|CLAUDE)/;
// Those pi reads (its bundled Anthropic SDK takes the last two), which its terminal goes without even
// where rhodium's own environment has none: the pane's comes from the Herdr server's (architecture §10.3).
// rh import refuses a pane whose pi has any (§10.1).
export const READ_BY_PI = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];

/** The environment a headless agent of the kind is launched with: env without what a parent session
 *  hands down, nor Claude's keys unless it may have them. */
export function headlessEnv(agent: AgentKind, env: Record<string, string>): Record<string, string> {
  const keys = agentDef(agent).claudeKeys;
  return Object.fromEntries(
    Object.entries(env).filter(([k]) => {
      const upper = k.toUpperCase();
      return !PARENT_SESSION.test(upper) && (keys || !CLAUDE_KEYS.test(upper));
    }),
  );
}

/** What the agent's terminal goes without, by name for env -u, as the pane's environment is the Herdr
 *  server's (architecture §10.3): Claude's keys, as headless, by those env has, which Herdr's
 *  environment shares, and those pi reads, matched case-insensitively on all platforms. */
export function terminalUnset(agent: AgentKind, env: Record<string, string | undefined>): string[] {
  if (agentDef(agent).claudeKeys) return [];
  return [...new Set([...READ_BY_PI, ...Object.keys(env).filter((k) => CLAUDE_KEYS.test(k.toUpperCase()))])];
}
