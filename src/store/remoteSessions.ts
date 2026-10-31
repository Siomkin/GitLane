// Each remote host's SSH session (remote-ssh-repos), keyed by its origin
// (`ssh://[user@]host[:port]`): connecting, installing GitLane's agent (with
// progress), connected, failed (with why), or disconnected. Fed by the
// `remote-session-changed` listener in `useRemoteSessionEvents`; the open dialog
// connects and reads SSH config hosts through its actions. A leaf store: no
// other store.

import { create } from "zustand";
import { REMOTE_LOCATOR_PREFIX } from "@/lib/paths";
import {
  api,
  type DirectoryEntry,
  type SshConnection,
  type RemoteHost,
  type RemoteSessionEvent,
  type SshPromptEvent,
} from "@/lib/api";

export type RemoteSession = Omit<RemoteSessionEvent, "origin">;

interface RemoteSessionsState {
  byOrigin: Record<string, RemoteSession>;
  /** Concrete `Host` names from `~/.ssh/config`, for the open dialog. */
  sshHosts: string[];
  /** Saved SSH connections, sorted by name (Rust owns the file). */
  connections: SshConnection[];
  loadConnections: () => Promise<void>;
  /** Save (or, with `previousOrigin`, edit) a connection; rejects with why not. */
  saveConnection: (previousOrigin: string | null, connection: SshConnection) => Promise<void>;
  deleteConnection: (origin: string) => Promise<void>;
  /** `ssh` questions waiting on the user, oldest first. The answer is never
   * kept here: it goes straight to `answerSshPrompt`. */
  prompts: SshPromptEvent[];
  /** Queue a question from `ssh-prompt` (once per id). */
  addPrompt: (prompt: SshPromptEvent) => void;
  /** Queue the questions still waiting in the backend: after a reload, the
   * `ssh-prompt` events that announced them are gone. */
  loadPrompts: () => Promise<void>;
  /** Answer (or, with `null`, cancel) question `id` and drop it from the queue. */
  answerPrompt: (id: number, answer: string | null) => Promise<void>;
  /** Record a host's latest session event. */
  apply: (event: RemoteSessionEvent) => void;
  /** Read `~/.ssh/config` hosts. Best effort: a failure leaves the list empty. */
  loadSshHosts: () => Promise<void>;
  /** Connect to `locator`'s host, installing the agent first if needed.
   * Rejects with the classified `CommandError` when the host can't be used. */
  connect: (locator: string) => Promise<RemoteHost>;
  /** Test a connection form's values on a connection of its own. */
  testConnection: (locator: string, identityFile: string | null) => Promise<RemoteHost>;
  /** End `origin`'s session when no open tab uses it: a test, or an open
   * dialog closed without opening a repository, mustn't leave one running.
   * `openPaths` is passed in: this leaf store can't read the repo store. */
  releaseUnused: (origin: string, openPaths: readonly string[]) => Promise<void>;
  /** The sub-folders of a folder on a connected host (`ssh://host/dir`), for
   * the open dialog's folder browser. */
  listDirectory: (locator: string) => Promise<DirectoryEntry[]>;
}

export const useRemoteSessions = create<RemoteSessionsState>((set) => ({
  byOrigin: {},
  sshHosts: [],
  connections: [],
  loadConnections: async () => {
    const connections = await api.listSshConnections().catch(() => null);
    if (connections) set({ connections });
  },
  saveConnection: async (previousOrigin, connection) => {
    set({ connections: await api.saveSshConnection(previousOrigin, connection) });
  },
  deleteConnection: async (origin) => {
    set({ connections: await api.deleteSshConnection(origin) });
  },
  prompts: [],
  addPrompt: (prompt) =>
    set((state) =>
      state.prompts.some((p) => p.id === prompt.id) ? state : { prompts: [...state.prompts, prompt] },
    ),
  loadPrompts: async () => {
    const pending = await api.listSshPrompts().catch(() => []);
    for (const prompt of pending) useRemoteSessions.getState().addPrompt(prompt);
  },
  answerPrompt: async (id, answer) => {
    set((state) => ({ prompts: state.prompts.filter((p) => p.id !== id) }));
    await api.answerSshPrompt(id, answer);
  },
  apply: ({ origin, ...session }) =>
    set((state) => ({ byOrigin: { ...state.byOrigin, [origin]: session } })),
  loadSshHosts: async () => {
    const sshHosts = await api.listSshHosts().catch(() => []);
    set({ sshHosts });
  },
  connect: (locator) => api.remoteConnect(locator),
  testConnection: (locator, identityFile) => api.testSshConnection(locator, identityFile),
  releaseUnused: async (origin, openPaths) => {
    if (openPaths.some((p) => p.startsWith(`${origin}/`))) return;
    await api.remoteDisconnect(`${origin}/`).catch(() => undefined);
  },
  listDirectory: (locator) => api.listDirectory(locator),
}));

/** Selector: the session for `origin`, if one has been reported. */
export const remoteSessionOf =
  (origin: string) =>
  (state: RemoteSessionsState): RemoteSession | undefined =>
    state.byOrigin[origin];

/** `ssh://[user@]host[:port]` of a saved connection, the same way Rust's
 * `Locator::origin` spells it. */
export function connectionOrigin({ host, user, port }: Pick<SshConnection, "host" | "user" | "port">): string {
  const bracketed = host.includes(":") ? `[${host}]` : host;
  return `${REMOTE_LOCATOR_PREFIX}${user ? `${user}@` : ""}${bracketed}${port ? `:${port}` : ""}`;
}

/** Selector: the saved connection for `origin`, if any. */
export const connectionFor =
  (origin: string) =>
  (state: RemoteSessionsState): SshConnection | undefined =>
    state.connections.find((c) => connectionOrigin(c) === origin);

