import { useEffect } from "react";
import { useRepo } from "@/store/repo";
import { sanitizeAutoFetchMinutes, useUi } from "@/store/ui";

/** A remote that keeps failing (expired token, deleted credential) would otherwise
 * retry — and re-drive the credential helpers — every tick forever, invisibly.
 * After this many consecutive failures the schedule pauses (with a one-time toast);
 * it resumes when the effect re-runs (repo switch, settings change, app restart). */
const MAX_CONSECUTIVE_FAILURES = 3;

/** Schedule opt-in background fetches for the active repository. The callback
 * reads fresh store state on every tick so repo switches and in-flight writes
 * cannot leak a fetch into the wrong checkout. */
export function useAutoFetch() {
  // `=== true` guards the persisted flag: rehydrated storage can hold any JSON
  // value, and a truthy non-boolean (e.g. "false") must not enable networking.
  const enabled = useUi((state) => state.autoFetchEnabled === true);
  // Sanitized at the selector: rehydrated storage can hold anything (e.g. the
  // pre-toggle 0 sentinel), and a NaN delay would make setInterval fire
  // immediately — an invalid cadence falls back to the default instead.
  const minutes = useUi((state) => sanitizeAutoFetchMinutes(state.autoFetchMinutes));
  const repoPath = useRepo((state) => state.summary?.path ?? null);

  useEffect(() => {
    if (!enabled || !repoPath) return;
    let failures = 0;
    // A fetch already on the wire can settle after this effect is torn down
    // (setting toggled, cadence changed, repo switched) — its completion must
    // not count toward the replacement schedule's backoff or raise the toast.
    let cancelled = false;
    const interval = window.setInterval(() => {
      const state = useRepo.getState();
      if (state.summary?.path !== repoPath) return;
      if (state.loading || state.netOps > 0 || state.remotes.length === 0) return;
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      void state
        .fetch({ quiet: true })
        .catch(() => false) // a rejection counts as a failure for the backoff
        .then((ok) => {
          if (cancelled) return;
          if (ok) {
            failures = 0;
            return;
          }
          failures += 1;
          if (failures >= MAX_CONSECUTIVE_FAILURES) {
            window.clearInterval(interval);
            useUi
              .getState()
              .showToast("Automatic fetch paused after repeated failures", "error");
          }
        });
    }, minutes * 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [enabled, minutes, repoPath]);
}
