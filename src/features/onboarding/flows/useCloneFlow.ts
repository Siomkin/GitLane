// Clone concern of the onboarding flow: the clone form (URL + destination), the
// streaming clone run with live progress, cancel, and retry. Owns only clone
// state; transitions the shared screen/result through the injected setters. The
// orchestrator (useOnboarding) composes this with useInitFlow.

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
// eslint-disable-next-line no-restricted-imports -- feature hook owning the clone flow/session (architecture-rules-react.md §1)
import { api, type CloneProgress } from "@/lib/api";
import { detectRemoteUrl } from "@/lib/remotes";
import {
  canceledCloneCopy,
  type CloneErrorCopy,
  isSafeLeafName,
  joinPath,
  type OnboardingResult,
  type OnboardingScreen,
  retryRerunsClone,
  validateCloneUrl,
} from "@/features/onboarding/onboarding";
import { runClone, type CloneStartOverrides } from "./clone-flow/runClone";
import { useCloneAuthModel } from "./clone-flow/useCloneAuthModel";
import { defaultParent } from "./parents";

const INITIAL_PROGRESS: CloneProgress = { stage: "Connecting to remote", pct: 0 };

interface CloneFlowDeps {
  setScreen: (screen: OnboardingScreen) => void;
  setResult: (result: OnboardingResult) => void;
}

export type { CloneStartOverrides };

export const useCloneFlow = ({ setScreen, setResult }: CloneFlowDeps) => {
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneParent, setCloneParent] = useState(defaultParent);
  // The destination folder leaf. `changeCloneUrl` adopts the URL's detected
  // repo name whenever that name changes, but a manual rename sticks until
  // then (the old name no longer fits a different repo).
  const [cloneFolder, setCloneFolder] = useState(() => validateCloneUrl("").repo);
  const [cloneAccountId, setCloneAccountId] = useState<string | null>(null);
  const [cloneUsername, setCloneUsername] = useState("");
  const [clonePassword, setClonePassword] = useState("");
  // Whether a token entered for a PR-capable forge is stored in GitLane's
  // keychain (enabling transport + pull requests) rather than the git helper
  // (transport only). `null` = the panel's default (on for Bitbucket/GitLab);
  // an explicit toggle overrides it (GL-152).
  const [cloneKeychain, setCloneKeychain] = useState<boolean | null>(null);
  const [progress, setProgress] = useState<CloneProgress>(INITIAL_PROGRESS);
  const [error, setError] = useState<CloneErrorCopy | null>(null);
  const cancelingRef = useRef(false);
  // Synchronous guard so a double-click can't fire two clones before the screen
  // switches away from the form (the backend would reject the second anyway). It
  // also tracks "a clone is in flight" for the unmount cleanup below.
  const cloningRef = useRef(false);
  const cloneRunRef = useRef<Promise<void> | null>(null);

  const { url, remoteInfo, cloneAuthAccounts, cloneAuthPlan, cloneAuthStatus } = useCloneAuthModel({
    cloneUrl,
    cloneAccountId,
    cloneUsername,
    clonePassword,
  });
  const cloneFolderValid = isSafeLeafName(cloneFolder);
  const canClone = url.state === "valid" && cloneParent.trim() !== "" && cloneFolderValid;

  /** The URL field's single entry point: commits the URL and every state it
   * derives in one event (the house rule — no state-sync effects). Auth belongs
   * to the credential authority + URL-embedded user, so when either changes,
   * nothing entered for the old one survives (the password NEVER carries
   * across authorities). The destination folder adopts the newly derived repo
   * name; a manual rename changed only `cloneFolder`, so it sticks until the
   * URL yields a different name. */
  const changeCloneUrl = useCallback(
    (nextUrl: string) => {
      const nextInfo = detectRemoteUrl(nextUrl);
      setCloneUrl(nextUrl);
      if (
        nextInfo.credentialHost !== remoteInfo.credentialHost ||
        nextInfo.user !== remoteInfo.user
      ) {
        setCloneAccountId(null);
        setCloneUsername(nextInfo.user ?? "");
        setClonePassword("");
        setCloneKeychain(null);
      }
      const nextRepo = validateCloneUrl(nextUrl).repo;
      if (nextRepo !== url.repo) setCloneFolder(nextRepo);
    },
    [remoteInfo, url.repo],
  );

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

  const startClone = useCallback((overrides?: CloneStartOverrides) => {
    if (cloningRef.current) return;
    // A transport switch passes the new URL explicitly (the setState that
    // updates the form field hasn't landed inside this tick).
    const rawUrl = overrides?.url ?? cloneUrl;
    const urlInfo = overrides?.url ? detectRemoteUrl(rawUrl) : remoteInfo;
    const validated = validateCloneUrl(rawUrl);
    if (validated.state !== "valid" || cloneParent.trim() === "") return;
    // The user's folder name if they renamed it, else the URL's detected name.
    const leaf = cloneFolder.trim() || validated.repo;
    if (!isSafeLeafName(leaf)) return;
    const dest = joinPath(cloneParent, leaf);
    cloningRef.current = true;
    cancelingRef.current = false;
    setError(null);
    setProgress(INITIAL_PROGRESS);
    setScreen("progress");
    const run = runClone({
      overrides,
      rawUrl,
      urlInfo,
      dest,
      cloneUsername,
      clonePassword,
      cloneAccountId,
      cloneAuthAccounts,
      cloneKeychain,
      cancelingRef,
      cloningRef,
      setClonePassword,
      setError,
      setScreen,
      setResult,
    });
    cloneRunRef.current = run;
    void run.finally(() => {
      if (cloneRunRef.current === run) cloneRunRef.current = null;
    });
  }, [cloneUrl, cloneParent, cloneFolder, cloneAccountId, cloneAuthAccounts, cloneUsername, clonePassword, cloneKeychain, remoteInfo, setScreen, setResult]);

  const cancelClone = useCallback(() => {
    if (!cloningRef.current || cancelingRef.current) return;
    cancelingRef.current = true;
    const run = cloneRunRef.current;
    void api
      .cancelClone()
      .then(async () => {
        // Backend cancellation kills the child first; its original clone IPC
        // settles after the process is reaped and private staging is cleaned.
        // Do not expose Retry while `cloningRef` would still drop that click.
        await run;
        setError(canceledCloneCopy());
        setScreen("error");
      })
      .catch(() => {
        // Publication already won the backend race. Let the in-flight clone
        // resolve normally instead of claiming a committed clone was canceled.
        cancelingRef.current = false;
      });
  }, [setScreen]);

  const retry = useCallback(() => {
    if (error && retryRerunsClone(error.kind)) {
      startClone();
    } else {
      // exists / unreachable → back to the form so the URL/destination can change.
      setScreen("clone");
    }
  }, [error, startClone, setScreen]);

  /** Recovery-panel transport switch: retry the clone over the alternative URL
   * (HTTPS↔SSH), starting from that transport's default auth — credentials
   * entered for the old URL are cleared, not carried over. The clears run
   * BEFORE changeCloneUrl so its conditional reset can still adopt a
   * URL-embedded user (recovery alternates never carry one today, but the
   * ordering keeps the old effect's resting state for any input). The form
   * field follows so a further failure reclassifies — and recovers — against
   * the URL actually attempted. */
  const retryWithUrl = useCallback(
    (nextUrl: string) => {
      setCloneAccountId(null);
      setCloneUsername("");
      setClonePassword("");
      changeCloneUrl(nextUrl);
      startClone({ url: nextUrl });
    },
    [changeCloneUrl, startClone],
  );

  /** Open the clone form fresh, clearing any prior error. */
  const goCloneForm = useCallback(() => {
    setError(null);
    setScreen("clone");
  }, [setScreen]);

  // Grouped contract (GL-194): screens consume the focused slice they need —
  // the form model, the run surface, or the failure recovery — instead of a
  // ~30-field flat facade. Plain per-render objects; the single top-level hook
  // re-renders every screen anyway, so memoizing them would buy nothing.
  return {
    /** Everything the clone form (and the recovery panel's inputs) binds to. */
    cloneForm: {
      url: cloneUrl,
      changeUrl: changeCloneUrl,
      validated: url,
      remoteInfo,
      parent: cloneParent,
      browseParent: browseCloneParent,
      folder: cloneFolder,
      setFolder: setCloneFolder,
      folderValid: cloneFolderValid,
      accountId: cloneAccountId,
      setAccountId: setCloneAccountId,
      username: cloneUsername,
      setUsername: setCloneUsername,
      password: clonePassword,
      setPassword: setClonePassword,
      keychain: cloneKeychain,
      setKeychain: setCloneKeychain,
      accounts: cloneAuthAccounts,
      authPlan: cloneAuthPlan,
      authStatus: cloneAuthStatus,
      canClone,
    },
    /** The clone run: start, live progress, cancel. */
    cloneRun: {
      start: startClone,
      progress,
      cancel: cancelClone,
    },
    /** The failed-clone surface: the classified error and its retries. */
    cloneRecovery: {
      error,
      retry,
      retryWithUrl,
    },
    goCloneForm,
  };
};
