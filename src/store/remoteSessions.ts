// Each remote host's SSH session (remote-ssh-repos), keyed by its origin
// (`ssh://[user@]host[:port]`): connecting, installing GitLane's agent (with
// progress), connected, failed (with why), or disconnected. Fed by the
// `remote-session-changed` listener in `useRemoteSessionEvents`; the open dialog
// connects and reads SSH config hosts through its actions. A leaf store: no
// other store.

import { create } from "zustand";
import {
  api,
  type DirectoryEntry,
  type RemoteHost,
  type RemoteSessionEvent,
  type SshPromptEvent,
} from "@/lib/api";

export type RemoteSession = Omit<RemoteSessionEvent, "origin">;

interface RemoteSessionsState {
  byOrigin: Record<string, RemoteSession>;
  /** Concrete `Host` names from `~/.ssh/config`, for the open dialog. */
  sshHosts: string[];
  /** `ssh` questions waiting on the user, oldest first. The answer is never
   * kept here: it goes straight to `answerSshPrompt`. */
  prompts: SshPromptEvent[];
  /** Queue a question from `ssh-prompt`. */
  addPrompt: (prompt: SshPromptEvent) => void;
  /** Answer (or, with `null`, cancel) question `id` and drop it from the queue. */
  answerPrompt: (id: number, answer: string | null) => Promise<void>;
  /** Record a host's latest session event. */
  apply: (event: RemoteSessionEvent) => void;
  /** Read `~/.ssh/config` hosts. Best effort: a failure leaves the list empty. */
  loadSshHosts: () => Promise<void>;
  /** Connect to `locator`'s host, installing the agent first if needed.
   * Rejects with the classified `CommandError` when the host can't be used. */
  connect: (locator: string) => Promise<RemoteHost>;
  /** The sub-folders of a folder on a connected host (`ssh://host/dir`), for
   * the open dialog's folder browser. */
  listDirectory: (locator: string) => Promise<DirectoryEntry[]>;
}

export const useRemoteSessions = create<RemoteSessionsState>((set) => ({
  byOrigin: {},
  sshHosts: [],
  prompts: [],
  addPrompt: (prompt) => set((state) => ({ prompts: [...state.prompts, prompt] })),
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
  listDirectory: (locator) => api.listDirectory(locator),
}));

/** Selector: the session for `origin`, if one has been reported. */
export const remoteSessionOf =
  (origin: string) =>
  (state: RemoteSessionsState): RemoteSession | undefined =>
    state.byOrigin[origin];
