// State machine for the repository onboarding flow (GL-38). Owns the transient
// UI state — which screen, the clone/init form fields, live clone progress, and
// the error/success result — while delegating durable work to the repo store
// (open/recents) and the backend (clone/init/reveal). The screens themselves are
// presentational and receive slices of this hook's return.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, type CloneProgress } from "../../lib/api";
import { repoLabel } from "../../lib/paths";
import { useRepo } from "../../store/repo";
import type { RecentRepo } from "../../store/repoSession";
import {
  canceledCloneCopy,
  classifyCloneError,
  type CloneErrorCopy,
  type GitignoreTemplate,
  joinPath,
  type OnboardingScreen,
  parentDir,
  parseRepoName,
  retryRerunsClone,
  type UrlState,
  validateCloneUrl,
} from "./onboarding";

/** The post-clone / post-init confirmation shown before entering the repo. */
export interface OnboardingResult {
  screen: "empty" | "opened";
  via: "clone" | "init";
  name: string;
  branch: string;
  path: string;
}

const INITIAL_PROGRESS: CloneProgress = { stage: "Connecting to remote", pct: 0 };

/** Default parent directory for a new clone/init: alongside the most recent repo,
 * so the common case needs no Browse. Empty when there are no recents yet. */
function defaultParent(): string {
  const recents = useRepo.getState().recents;
  return recents[0] ? parentDir(recents[0].path) : "";
}

/** @param onDone Called after an action opens a repo — used by the overlay
 * (open-state) entry point to dismiss itself once a repo is opened. */
export const useOnboarding = (onDone?: () => void) => {
  const recents = useRepo((state) => state.recents);

  const [screen, setScreen] = useState<OnboardingScreen>("home");

  // Clone form / flow.
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneParent, setCloneParent] = useState(defaultParent);
  const [progress, setProgress] = useState<CloneProgress>(INITIAL_PROGRESS);
  const [error, setError] = useState<CloneErrorCopy | null>(null);
  const cancelingRef = useRef(false);
  // Synchronous guard so a double-click can't fire two clones before the screen
  // switches away from the form (the backend would reject the second anyway).
  const cloningRef = useRef(false);

  // Init form.
  const [initParent, setInitParent] = useState(defaultParent);
  const [initName, setInitName] = useState("my-project");
  const [initBranch, setInitBranch] = useState("main");
  const [initReadme, setInitReadme] = useState(true);
  const [initIgnore, setInitIgnore] = useState<GitignoreTemplate>("None");
  const [initError, setInitError] = useState<string | null>(null);
  const [initBusy, setInitBusy] = useState(false);
  // Synchronous guard against a double-submit firing two init_repo calls before
  // the async `initBusy` state has a chance to disable the button.
  const initBusyRef = useRef(false);

  // Post-clone/init confirmation.
  const [result, setResult] = useState<OnboardingResult | null>(null);

  const url = useMemo(() => validateCloneUrl(cloneUrl), [cloneUrl]);

  // Refresh recents' presence + branch from disk when the start screen mounts.
  useEffect(() => {
    void useRepo.getState().refreshRecents();
  }, []);

  // Live clone progress streamed from the backend.
  useEffect(() => {
    const unlisten = listen<CloneProgress>("clone-progress", ({ payload }) => {
      setProgress(payload);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  // Track the live screen for the unmount cleanup below (avoids re-subscribing).
  const screenRef = useRef(screen);
  screenRef.current = screen;

  // If the overlay is dismissed mid-clone (Close / Escape / repo switch unmounts
  // this hook), stop the background clone rather than letting it run on with no
  // UI. The canceling flag also suppresses the in-flight startClone's post-await
  // state updates on the now-unmounted hook.
  useEffect(() => {
    return () => {
      if (screenRef.current === "progress") {
        cancelingRef.current = true;
        void api.cancelClone().catch(() => {});
      }
    };
  }, []);

  // ---- navigation ----
  const goHome = useCallback(() => setScreen("home"), []);
  const goClone = useCallback(() => {
    setError(null);
    setScreen("clone");
  }, []);
  const goInit = useCallback(() => {
    setInitError(null);
    setScreen("init");
  }, []);

  // ---- open existing (straight into the repo, no confirmation screen) ----
  const openLocal = useCallback(() => {
    void (async () => {
      const before = useRepo.getState().summary?.path ?? null;
      await useRepo.getState().pickAndOpen();
      // Only dismiss the overlay if a repo actually opened (dialog not canceled).
      if ((useRepo.getState().summary?.path ?? null) !== before) onDone?.();
    })();
  }, [onDone]);

  const openRecent = useCallback(
    (repo: RecentRepo) => {
      if (repo.missing) {
        // The path moved/disappeared: let the user point at its new location.
        // loadRepo swallows a failed open (sets the error bar and returns), so
        // only drop the stale entry + dismiss once a repo *actually* opened —
        // detected by the active path changing. Picking a non-repo folder leaves
        // the missing entry and overlay in place so the user can retry.
        void (async () => {
          const picked = await openDialog({ directory: true, multiple: false });
          if (typeof picked !== "string") return;
          const before = useRepo.getState().summary?.path ?? null;
          await useRepo.getState().loadRepo(picked);
          if ((useRepo.getState().summary?.path ?? null) !== before) {
            useRepo.getState().removeRecent(repo.path);
            onDone?.();
          }
        })();
        return;
      }
      void (async () => {
        const before = useRepo.getState().summary?.path ?? null;
        await useRepo.getState().loadRepo(repo.path);
        const after = useRepo.getState().summary?.path ?? null;
        // Dismiss only once we're actually on the target repo — it became active
        // (path changed) or already was. A failed open leaves the previous repo
        // active, so the overlay stays open and the error bar surfaces.
        if (after !== before || after === repo.path) onDone?.();
      })();
    },
    [onDone],
  );

  const clearRecents = useCallback(() => useRepo.getState().clearRecents(), []);

  // ---- clone ----
  const browseCloneParent = useCallback(() => {
    void (async () => {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === "string") setCloneParent(picked);
    })();
  }, []);

  const canClone = url.state === "valid" && cloneParent.trim() !== "";

  const startClone = useCallback(() => {
    if (cloningRef.current) return;
    const validated = validateCloneUrl(cloneUrl);
    if (validated.state !== "valid" || cloneParent.trim() === "") return;
    const dest = joinPath(cloneParent, validated.repo);
    cloningRef.current = true;
    cancelingRef.current = false;
    setError(null);
    setProgress(INITIAL_PROGRESS);
    setScreen("progress");
    void (async () => {
      try {
        const path = await api.cloneRepo(cloneUrl.trim(), dest);
        if (cancelingRef.current) return;
        // Read the cloned repo so the confirmation shows its real branch/path.
        let name = parseRepoName(cloneUrl);
        let branch = "main";
        let finalPath = path;
        try {
          const summary = await api.openRepo(path);
          finalPath = summary.path;
          name = repoLabel(summary.path);
          branch = summary.headBranch ?? "main";
        } catch {
          /* fall back to the parsed name/path */
        }
        setResult({ screen: "opened", via: "clone", name, branch, path: finalPath });
        setScreen("opened");
      } catch (e) {
        if (cancelingRef.current) return; // cancel already showed its own screen
        setError(classifyCloneError(String(e)));
        setScreen("error");
      } finally {
        cloningRef.current = false;
      }
    })();
  }, [cloneUrl, cloneParent]);

  const cancelClone = useCallback(() => {
    cancelingRef.current = true;
    void api.cancelClone().catch(() => {});
    setError(canceledCloneCopy());
    setScreen("error");
  }, []);

  const retry = useCallback(() => {
    if (error && retryRerunsClone(error.kind)) {
      startClone();
    } else {
      // exists / unreachable → back to the form so the URL/destination can change.
      setScreen("clone");
    }
  }, [error, startClone]);

  // ---- init ----
  const browseInitParent = useCallback(() => {
    void (async () => {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === "string") setInitParent(picked);
    })();
  }, []);

  const toggleReadme = useCallback(() => setInitReadme((v) => !v), []);

  const canInit = initParent.trim() !== "" && initName.trim() !== "";

  const startInit = useCallback(() => {
    if (initBusyRef.current) return;
    if (initParent.trim() === "" || initName.trim() === "") return;
    const name = initName.trim();
    const branch = initBranch.trim() || "main";
    initBusyRef.current = true;
    setInitError(null);
    setInitBusy(true);
    void (async () => {
      try {
        const path = await api.initRepo(initParent, name, branch, initReadme, initIgnore);
        setResult({ screen: "empty", via: "init", name, branch, path });
        setScreen("empty");
      } catch (e) {
        setInitError(String(e));
      } finally {
        initBusyRef.current = false;
        setInitBusy(false);
      }
    })();
  }, [initParent, initName, initBranch, initReadme, initIgnore]);

  // ---- result (enter the repo / reveal it) ----
  const enterResult = useCallback(() => {
    if (!result) return;
    void (async () => {
      const before = useRepo.getState().summary?.path ?? null;
      await useRepo.getState().loadRepo(result.path);
      const after = useRepo.getState().summary?.path ?? null;
      // Only dismiss once the repo opened (path changed / already active); a
      // failed open keeps the success screen rather than dropping to a bare error.
      if (after !== before || after === result.path) onDone?.();
    })();
  }, [result, onDone]);

  const revealResult = useCallback(() => {
    if (result) void api.revealPath(result.path).catch(() => {});
  }, [result]);

  return {
    screen,
    goHome,
    // home
    recents,
    goClone,
    goInit,
    openLocal,
    openRecent,
    clearRecents,
    // clone
    cloneUrl,
    setCloneUrl,
    url,
    cloneParent,
    browseCloneParent,
    canClone,
    startClone,
    // progress
    progress,
    cancelClone,
    // error
    error,
    retry,
    // init
    initParent,
    browseInitParent,
    initName,
    setInitName,
    initBranch,
    setInitBranch,
    initReadme,
    toggleReadme,
    initIgnore,
    setInitIgnore,
    initError,
    initBusy,
    canInit,
    startInit,
    // result
    result,
    enterResult,
    revealResult,
  };
};

export type OnboardingApi = ReturnType<typeof useOnboarding>;
export type { UrlState };
