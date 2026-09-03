// Re-probe the external tools before an operation that may depend on one the
// user just installed. The backend caches its `git` / `gh` / `glab` / `origin`
// probes until told otherwise (`ipc/commands` spec: availability is re-checked
// without restart); the stores call this from the account add/remove actions
// and the PR-list retry so a CLI installed mid-session is seen on the very
// next attempt instead of after a relaunch.

import { api } from "@/lib/api";

/** Drop the backend's cached tool probes. Best-effort: a failure here must
 * never block the operation that follows — the worst case is that it still
 * sees the previous probe, exactly as it would have without the refresh. */
export async function refreshToolProbes(): Promise<void> {
  try {
    await api.refreshToolProbes();
  } catch {
    /* the following operation simply reuses the last probe */
  }
}
