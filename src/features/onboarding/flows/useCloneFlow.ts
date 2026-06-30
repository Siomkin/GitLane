// Clone concern of the onboarding flow: the clone form (URL + destination), the
// streaming clone run with live progress, cancel, and retry. Owns only clone
// state; transitions the shared screen/result through the injected setters. The
// orchestrator (useOnboarding) composes this with useInitFlow.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
// eslint-disable-next-line no-restricted-imports -- feature hook owning the clone flow/session (architecture-rules-react.md §1)
import { api, type CloneProgress } from "../../../lib/api";
import { repoLabel } from "../../../lib/paths";
import {
  canceledCloneCopy,
  classifyCloneError,
  type CloneErrorCopy,
  joinPath,
  type OnboardingResult,
  type OnboardingScreen,
  parseRepoName,
  retryRerunsClone,
  validateCloneUrl,
} from "../onboarding";
import { defaultParent } from "./parents";

const INITIAL_PROGRESS: CloneProgress = { stage: "Connecting to remote", pct: 0 };

interface CloneFlowDeps {
  setScreen: (screen: OnboardingScreen) => void;
  setResult: (result: OnboardingResult) => void;
}

export const useCloneFlow = ({ setScreen, setResult }: CloneFlowDeps) => {
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneParent, setCloneParent] = useState(defaultParent);
  const [progress, setProgress] = useState<CloneProgress>(INITIAL_PROGRESS);
  const [error, setError] = useState<CloneErrorCopy | null>(null);
  const cancelingRef = useRef(false);
  // Synchronous guard so a double-click can't fire two clones before the screen
  // switches away from the form (the backend would reject the second anyway). It
  // also tracks "a clone is in flight" for the unmount cleanup below.
  const cloningRef = useRef(false);

  const url = useMemo(() => validateCloneUrl(cloneUrl), [cloneUrl]);
  const canClone = url.state === "valid" && cloneParent.trim() !== "";

  // Live clone progress streamed from the backend.
  useEffect(() => {
    const unlisten = listen<CloneProgress>("clone-progress", ({ payload }) => {
      setProgress(payload);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  // If the flow unmounts mid-clone (the overlay was dismissed — Close / Escape /
  // repo switch), stop the background clone instead of letting it run on with no
  // UI. The canceling flag also suppresses the in-flight run's post-await state
  // updates on the now-unmounted hook.
  useEffect(() => {
    return () => {
      if (cloningRef.current) {
        cancelingRef.current = true;
        void api.cancelClone().catch(() => {});
      }
    };
  }, []);

  const browseCloneParent = useCallback(() => {
    void (async () => {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === "string") setCloneParent(picked);
    })();
  }, []);

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
        setResult({ name, branch, path: finalPath });
        setScreen("opened");
      } catch (e) {
        if (cancelingRef.current) return; // cancel already showed its own screen
        setError(classifyCloneError(String(e)));
        setScreen("error");
      } finally {
        cloningRef.current = false;
      }
    })();
  }, [cloneUrl, cloneParent, setScreen, setResult]);

  const cancelClone = useCallback(() => {
    cancelingRef.current = true;
    void api.cancelClone().catch(() => {});
    setError(canceledCloneCopy());
    setScreen("error");
  }, [setScreen]);

  const retry = useCallback(() => {
    if (error && retryRerunsClone(error.kind)) {
      startClone();
    } else {
      // exists / unreachable → back to the form so the URL/destination can change.
      setScreen("clone");
    }
  }, [error, startClone, setScreen]);

  /** Open the clone form fresh, clearing any prior error. */
  const goCloneForm = useCallback(() => {
    setError(null);
    setScreen("clone");
  }, [setScreen]);

  return {
    cloneUrl,
    setCloneUrl,
    url,
    cloneParent,
    browseCloneParent,
    canClone,
    startClone,
    progress,
    cancelClone,
    error,
    retry,
    goCloneForm,
  };
};
