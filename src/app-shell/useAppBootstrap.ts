import { useEffect } from "react";

import { useRepoWatcher } from "@/hooks/useRepoWatcher";
import { isTauri } from "@/lib/platform";
import { useAccounts } from "@/store/accounts";
import { useRepo } from "@/store/repo";
import { useUpdates } from "@/store/updates";

/** App-launch wiring, mounted once from the root: reopen the last active
 * repository, load `gh` accounts and non-GitHub forge CLI auth, run the quiet
 * daily update check, and keep the repo in sync with on-disk changes
 * (focus/visibility + the backend `repo-changed` filesystem event, debounced —
 * see useRepoWatcher). */
export const useAppBootstrap = () => {
  const loadAccounts = useAccounts((state) => state.loadAccounts);
  const loadForgeAuth = useAccounts((state) => state.loadForgeAuth);
  const restoreSession = useRepo((state) => state.restoreSession);
  const refresh = useRepo((state) => state.refresh);

  useEffect(() => {
    void loadAccounts();
    void loadForgeAuth();
    void restoreSession();
  }, [loadAccounts, loadForgeAuth, restoreSession]);

  // Quiet update check on launch — populates the version and lights the
  // titlebar indicator if a newer build exists (the once-a-day/toggle policy
  // lives in the store). Gated on isTauri so `bun run dev` (plain browser)
  // doesn't show a bogus state.
  useEffect(() => {
    if (!isTauri) return;
    void useUpdates.getState().checkOnLaunch();
  }, []);

  useRepoWatcher(refresh);
};
