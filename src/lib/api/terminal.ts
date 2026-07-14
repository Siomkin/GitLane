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

  /** Persist both commit-agent instructions independently from the agent list. */
  commitAgentMessagesSet: (messages: CommitAgentMessages) =>
    invoke<void>("commit_agent_messages_set", { messages }),

  /** Restore the shipped commit-agent instructions and return them. */
  commitAgentMessagesReset: () =>
    invoke<CommitAgentMessages>("commit_agent_messages_reset"),

  /** Probe whether a single command's executable resolves on PATH (live check). */
  terminalAgentProbe: (command: string) =>
    invoke<boolean>("terminal_agent_probe", { command }),

  /** Consume a completed commit-message draft from the selected terminal agent. */
  takeAgentCommitDraft: (path: string, token: string) =>
    invoke<string | null>("take_agent_commit_draft", { path, token }),

  /** Consume a completed working-change summary from a terminal agent. */
  takeAgentChangeSummary: (path: string, token: string) =>
    invoke<string | null>("take_agent_change_summary", { path, token }),

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
