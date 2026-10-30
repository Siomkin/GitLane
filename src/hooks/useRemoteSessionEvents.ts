import { useEffect } from "react";
import {
  listenTyped,
  REMOTE_SESSION_CHANGED,
  remoteSessionEventSchema,
  SSH_PROMPT,
  sshPromptEventSchema,
} from "@/lib/api";
import { isRemoteLocator, remoteOrigin } from "@/lib/paths";
import { useRemoteSessions } from "@/store/remoteSessions";
import { useRepo } from "@/store/repo";

/**
 * Keep `useRemoteSessions` current from `remote-session-changed`, and react when
 * the active tab's host drops: a quiet refresh either reconnects (the next
 * request opens a fresh session) or fails with `remoteUnavailable`, which moves
 * the tab to its disconnected state with a Reconnect action. Other tabs, local
 * or on other hosts, are untouched. One-shot `getState` reads, so the listener
 * never re-subscribes on store churn. Questions `ssh` asks while connecting
 * queue in the store for the prompt dialog.
 */
export function useRemoteSessionEvents() {
  useEffect(() => {
    const unlisten = listenTyped(REMOTE_SESSION_CHANGED, remoteSessionEventSchema, (event) => {
      useRemoteSessions.getState().apply(event);
      if (event.state !== "disconnected") return;
      const { summary, refresh } = useRepo.getState();
      if (summary && isRemoteLocator(summary.path) && remoteOrigin(summary.path) === event.origin) {
        void refresh({ prs: false, quiet: true });
      }
    });
    const unlistenPrompts = listenTyped(SSH_PROMPT, sshPromptEventSchema, (prompt) =>
      useRemoteSessions.getState().addPrompt(prompt),
    );
    return () => {
      void unlisten.then((off) => off());
      void unlistenPrompts.then((off) => off());
    };
  }, []);
}
