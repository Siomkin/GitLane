// Each remote host's SSH session (remote-ssh-repos), keyed by its origin
// (`ssh://[user@]host[:port]`): connecting, installing GitLane's agent (with
// progress), connected, failed (with why), or disconnected. Fed by the
// `remote-session-changed` listener in `useRemoteSessionEvents`; the open dialog
// connects and reads SSH config hosts through its actions. A leaf store: no
// other store.

import { create } from "zustand";
import { api, type RemoteHost, type RemoteSessionEvent } from "@/lib/api";

export type RemoteSession = Omit<RemoteSessionEvent, "origin">;

interface RemoteSessionsState {
  byOrigin: Record<string, RemoteSession>;
  /** Concrete `Host` names from `~/.ssh/config`, for the open dialog. */
  sshHosts: string[];
  /** Record a host's latest session event. */
  apply: (event: RemoteSessionEvent) => void;
  /** Read `~/.ssh/config` hosts. Best effort: a failure leaves the list empty. */
  loadSshHosts: () => Promise<void>;
  /** Connect to `locator`'s host, installing the agent first if needed.
   * Rejects with the classified `CommandError` when the host can't be used. */
  connect: (locator: string) => Promise<RemoteHost>;
}

export const useRemoteSessions = create<RemoteSessionsState>((set) => ({
  byOrigin: {},
  sshHosts: [],
  apply: ({ origin, ...session }) =>
    set((state) => ({ byOrigin: { ...state.byOrigin, [origin]: session } })),
  loadSshHosts: async () => {
    const sshHosts = await api.listSshHosts().catch(() => []);
    set({ sshHosts });
  },
  connect: (locator) => api.remoteConnect(locator),
}));

/** Selector: the session for `origin`, if one has been reported. */
export const remoteSessionOf =
  (origin: string) =>
  (state: RemoteSessionsState): RemoteSession | undefined =>
    state.byOrigin[origin];
