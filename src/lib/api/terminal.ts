import { invoke } from "@tauri-apps/api/core";

/** A user-configurable terminal agent: an AI CLI (or any command) launched by
 * typing `command` into the integrated terminal's shell. The full list lives in
 * a backend config file (app data dir) and is edited from Settings. */
export interface TerminalAgent {
  /** Stable unique id (fixed for the four built-ins, uuid for user-added). */
  id: string;
  /** Display name — the toolbar button text and the Settings row title. */
  name: string;
  /** Command typed into the running shell (e.g. `claude`, `claude --model ...`). */
  command: string;
  /** One-line description shown as the toolbar tooltip / Settings subtitle. */
  description: string;
  /** Visibility toggle — disabled agents stay in the config but hide from the toolbar. */
  enabled: boolean;
  /** False when the command's binary isn't on PATH; the toolbar greys those out.
   *  Computed by the backend on each load — never persisted. */
  available: boolean;
}

export interface CommitAgentMessages {
  draftInstruction: string;
  commitInstruction: string;
  descriptionInstruction: string;
}

/** An ACP adapter GitLane knows how to launch, offered in Settings. */
export interface AcpAdapter {
  id: string;
  name: string;
  /** What to put in an agent's ACP command. */
  command: string;
  /** Optional global install of the *adapter*, shown as a copyable hint —
   *  `npx -y` already fetches on demand, so this only buys a faster first run.
   *  Empty for agents whose CLI speaks ACP itself (`<cli> acp`). */
  install: string;
  /** Where to get the underlying CLI, linked when a probe fails. */
  docs: string;
  /** What the adapter drives, and therefore whose login it uses. */
  requires: string;
  /** True when the adapter's executable resolves on PATH — a filesystem lookup,
   *  no process started, so readiness shows without the user checking anything.
   *  Only the model list needs a real launch. */
  available: boolean;
}

/** What an adapter reports about itself on a bare handshake. */
export interface AcpProbe {
  agentName: string;
  agentVersion: string;
  /** Empty when the adapter exposes no model selection — nothing to choose,
   *  not a failure. Prefer configOptions category `model` when present (Codex
   *  pairs it with a separate thought_level); fall back to
   *  models.availableModels. */
  models: AcpModel[];
  currentModelId: string;
  /** Select options beside the model list (effort, fast, …). Empty when the
   *  adapter offers none. */
  configOptions: AcpConfigOption[];
}

export interface AcpModel {
  id: string;
  name: string;
  description: string;
}

/** A session config option other than the model selector (effort, fast, …). */
export interface AcpConfigOption {
  id: string;
  name: string;
  category: string;
  currentValue: string;
  options: AcpModel[];
}

/** An AI agent: one that answers in-app requests over ACP. Separate from
 *  `TerminalAgent`, which is a command typed into a terminal tab — the two share
 *  nothing but the word "agent". */
export interface AcpAgent {
  id: string;
  /** Display name — what the Draft / Describe menus list. */
  name: string;
  /** The ACP adapter command, e.g. `cursor-agent acp`. */
  command: string;
  /** Adapter-defined model id this agent pins its session to (`""` = the
   *  adapter's default), applied via `session/set_model` /
   *  `session/set_config_option`. */
  model: string;
  /** Other session config pins keyed by option id (`effort`, `fast`, …).
   *  Empty / missing values mean the adapter default and are not sent. */
  config: Record<string, string>;
  description: string;
  enabled: boolean;
  /** True when the adapter's executable resolves on PATH. Computed per read. */
  available: boolean;
}

export interface PtySpawnResponse {
  sessionId: number;
}

export interface PtyDataEvent {
  sessionId: number;
  data: number[];
}

export interface PtyExitEvent {
  sessionId: number;
}

export const terminalApi = {
  /** All configured terminal agents with availability probed via PATH. */
  terminalAgentsGet: () => invoke<TerminalAgent[]>("terminal_agents_get"),

  /** Persist the full agent list (replaces the config). `available` is ignored. */
  terminalAgentsSet: (agents: TerminalAgent[]) =>
    invoke<void>("terminal_agents_set", { agents }),

  /** Reset the agent config to the shipped defaults; returns the fresh list. */
  terminalAgentsReset: () => invoke<TerminalAgent[]>("terminal_agents_reset"),

  /** Read the editable instructions used by commit-agent actions. */
  commitAgentMessagesGet: () =>
    invoke<CommitAgentMessages>("commit_agent_messages_get"),

  /** Persist agent-action instructions independently from the agent list. */
  commitAgentMessagesSet: (messages: CommitAgentMessages) =>
    invoke<void>("commit_agent_messages_set", { messages }),

  /** Restore the shipped agent-action instructions and return them. */
  commitAgentMessagesReset: () =>
    invoke<CommitAgentMessages>("commit_agent_messages_reset"),

  /** Probe whether a single command's executable resolves on PATH (live check). */
  terminalAgentProbe: (command: string) =>
    invoke<boolean>("terminal_agent_probe", { command }),

  /** The user's AI agents (the ones that answer Draft / Describe over ACP). */
  acpAgentsGet: () => invoke<AcpAgent[]>("acp_agents_get"),

  /** Persist the full AI-agent list (replaces the config). */
  acpAgentsSet: (agents: AcpAgent[]) => invoke<void>("acp_agents_set", { agents }),

  /** Reset the AI-agent list to the seeded defaults; returns the fresh list. */
  acpAgentsReset: () => invoke<AcpAgent[]>("acp_agents_reset"),

  /** The ACP adapters GitLane has been verified against (static list). */
  acpAdapters: () => invoke<AcpAdapter[]>("acp_adapters"),

  /** Ask an ACP adapter what it is and which models it offers. A successful
   *  probe means installed + launchable + signed in; a rejection says which of
   *  those failed. Backs the Settings status row and model picker. */
  acpProbe: (agentCommand: string, path: string) =>
    invoke<AcpProbe>("acp_probe", { agentCommand, path }),

  /** Ask an ACP-capable agent one question about the repo at `path` and resolve
   *  with its answer. Structured alternative to the terminal + mailbox handoff:
   *  no token, no delivery contract, no polling, and failures say what broke.
   *  `config` carries non-model session pins (effort, fast, …). `runId` tags
   *  every `acp-progress` tick so concurrent Draft/Describe banners stay isolated. */
  acpPrompt: (
    agentCommand: string,
    path: string,
    model: string,
    config: Record<string, string>,
    prompt: string,
    runId: string,
  ) => invoke<string>("acp_prompt", { agentCommand, path, model, config, prompt, runId }),

  /** Stop the ACP turn `runId` started, ending the adapter process. Resolves
   *  `false` when the turn had already finished — Stop arriving late is normal,
   *  not an error. */
  acpCancel: (runId: string) => invoke<boolean>("acp_cancel", { runId }),

  /** Spawn a new in-app terminal PTY running the user's shell in `path`.
   *  Returns its `sessionId`; existing sessions keep running. */
  ptySpawn: (path: string, cols: number, rows: number) =>
    invoke<PtySpawnResponse>("pty_spawn", { path, cols, rows }),

  /** Forward user keystrokes (from xterm.js) to session `sessionId`'s stdin. */
  ptyWrite: (sessionId: number, data: Uint8Array) =>
    invoke<void>("pty_write", { sessionId, data }),

  /** Resize session `sessionId`'s PTY to match the xterm.js viewport. */
  ptyResize: (sessionId: number, cols: number, rows: number) =>
    invoke<void>("pty_resize", { sessionId, cols, rows }),

  /** Kill one terminal tab's shell. Called when the user closes that tab. */
  ptyKill: (sessionId: number) => invoke<void>("pty_kill", { sessionId }),
};
