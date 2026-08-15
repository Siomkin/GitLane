// Orchestrator for the repository onboarding flow (GL-38). Owns the screen state
// machine and the shared post-clone/init result, plus the open-existing actions
// (open local, open/relocate recents). The heavy clone and init concerns live in
// their own hooks (useCloneFlow / useInitFlow); this composes them and exposes a
// single flat API the presentational screens consume. Splitting keeps each
// concern to one reason to change (architecture-rules-react §4).

import { useCallback, useEffect, useState } from "react";
// eslint-disable-next-line no-restricted-imports -- feature hook owning the onboarding flow (architecture-rules-react.md §1)
import { api } from "@/lib/api";
import { useRepo } from "@/store/repo";
import type { RecentRepo } from "@/store/repoSession";
import type { OnboardingResult, OnboardingScreen } from "@/features/onboarding/onboarding";
import { useCloneFlow } from "./useCloneFlow";
import { useInitFlow } from "./useInitFlow";

/** @param onDone Called after an action opens a repo — used by the overlay
 * (open-state) entry point to dismiss itself once a repo is opened. */
export const useOnboarding = (onDone?: () => void) => {
  const recents = useRepo((state) => state.recents);
  const [screen, setScreen] = useState<OnboardingScreen>("home");
  const [result, setResult] = useState<OnboardingResult | null>(null);

  const { goCloneForm, cloneForm, cloneRun, cloneRecovery } = useCloneFlow({ setScreen, setResult });
  const { goInitForm, ...init } = useInitFlow({ setScreen, setResult });

  // Refresh recents' presence + branch from disk when the start screen mounts.
  useEffect(() => {
    void useRepo.getState().refreshRecents();
  }, []);

  const goHome = useCallback(() => setScreen("home"), []);

  // Dismiss once the active path changed, or is already the known target
  // (re-opening the repo that's up is a successful open). Omit `target` when
  // the destination isn't known beforehand (Locate… a missing recent).
  const openAndDismiss = useCallback(
    async (run: () => Promise<void>, target?: string) => {
      const before = useRepo.getState().summary?.path ?? null;
      await run();
      const after = useRepo.getState().summary?.path ?? null;
      if (after !== before || (target !== undefined && after === target)) onDone?.();
    },
    [onDone],
  );

  // ---- open existing (straight into the repo, no confirmation screen) ----
  const openLocal = useCallback(() => {
    // Pass the active path so re-picking the already-open repo dismisses too.
    void openAndDismiss(() => useRepo.getState().pickAndOpen(), useRepo.getState().summary?.path);
  }, [openAndDismiss]);

  const openRecent = useCallback(
    (repo: RecentRepo) => {
      if (repo.missing) {
        // The path moved/disappeared: the shared Locate… flow (GL-108) opens
        // the picker, probes the pick with the classified open, migrates the
        // stale path's per-repo bindings to the new location, and drops the
        // dead entry — the same treatment as the missing-repo tab screen.
        void openAndDismiss(() => useRepo.getState().locateMissingRepo(repo.path));
        return;
      }
      void openAndDismiss(() => useRepo.getState().loadRepo(repo.path), repo.path);
    },
    [openAndDismiss],
  );

  const clearRecents = useCallback(() => useRepo.getState().clearRecents(), []);

  // ---- result (enter the repo / reveal it) ----
  const enterResult = useCallback(() => {
    if (!result) return;
    void openAndDismiss(() => useRepo.getState().loadRepo(result.path), result.path);
  }, [result, openAndDismiss]);

  const revealResult = useCallback(() => {
    if (result) void api.revealPath(result.path).catch(() => {});
  }, [result]);

  return {
    screen,
    goHome,
    // home
    recents,
    goClone: goCloneForm,
    goInit: goInitForm,
    openLocal,
    openRecent,
    clearRecents,
    // clone flow, grouped by the slice a screen consumes (GL-194)
    cloneForm,
    cloneRun,
    cloneRecovery,
    // init flow (form)
    ...init,
    // result
    result,
    enterResult,
    revealResult,
  };
};

export type OnboardingApi = ReturnType<typeof useOnboarding>;
