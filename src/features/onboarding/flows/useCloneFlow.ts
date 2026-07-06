// Clone concern of the onboarding flow: the clone form (URL + destination), the
// streaming clone run with live progress, cancel, and retry. Owns only clone
// state; transitions the shared screen/result through the injected setters. The
// orchestrator (useOnboarding) composes this with useInitFlow.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
// eslint-disable-next-line no-restricted-imports -- feature hook owning the clone flow/session (architecture-rules-react.md §1)
import { api, type CloneProgress, type GitTransportAuthRef } from "../../../lib/api";
import { repoLabel } from "../../../lib/paths";
import { detectRemoteUrl, withUrlUser } from "../../../lib/remotes";
import { useAccounts } from "../../../store/accounts";
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
  const [cloneAccountId, setCloneAccountId] = useState<string | null>(null);
  const [cloneUsername, setCloneUsername] = useState("");
  const [clonePassword, setClonePassword] = useState("");
  const [progress, setProgress] = useState<CloneProgress>(INITIAL_PROGRESS);
  const [error, setError] = useState<CloneErrorCopy | null>(null);
  const cancelingRef = useRef(false);
  // Synchronous guard so a double-click can't fire two clones before the screen
  // switches away from the form (the backend would reject the second anyway). It
  // also tracks "a clone is in flight" for the unmount cleanup below.
  const cloningRef = useRef(false);

  const url = useMemo(() => validateCloneUrl(cloneUrl), [cloneUrl]);
  const remoteInfo = useMemo(() => detectRemoteUrl(cloneUrl), [cloneUrl]);
  const accounts = useAccounts((s) => s.accounts);
  const cloneAuthAccounts = useMemo(
    () =>
      remoteInfo.valid && !remoteInfo.ssh && remoteInfo.credentialHost
        ? accounts.filter((a) => a.host === remoteInfo.credentialHost)
        : [],
    [accounts, remoteInfo.credentialHost, remoteInfo.ssh, remoteInfo.valid],
  );
  const canClone = url.state === "valid" && cloneParent.trim() !== "";

  useEffect(() => {
    setCloneAccountId(null);
    setCloneUsername(remoteInfo.user ?? "");
    setClonePassword("");
  }, [remoteInfo.credentialHost, remoteInfo.user]);

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
        const selectedAccount = cloneAuthAccounts.find((a) => a.id === cloneAccountId) ?? null;
        const username = selectedAccount?.login ?? cloneUsername.trim();
        const cloneRemoteUrl =
          remoteInfo.valid && !remoteInfo.ssh && username
            ? withUrlUser(cloneUrl.trim(), username)
            : cloneUrl.trim();
        const provider =
          remoteInfo.provider === "azure"
            ? "azure-devops"
            : remoteInfo.provider === "github" ||
                remoteInfo.provider === "gitlab" ||
                remoteInfo.provider === "bitbucket"
              ? remoteInfo.provider
              : "other";
        const auth: GitTransportAuthRef | null =
          remoteInfo.valid &&
          !remoteInfo.ssh &&
          remoteInfo.host &&
          remoteInfo.credentialHost &&
          (username || clonePassword)
            ? selectedAccount
              ? {
                  mode: "githubGh",
                  provider: "github",
                  host: remoteInfo.host,
                  credentialHost: remoteInfo.credentialHost,
                  username,
                  accountRef: selectedAccount.ref,
                }
              : {
                  mode: "credentialHelper",
                  provider,
                  host: remoteInfo.host,
                  credentialHost: remoteInfo.credentialHost,
                  username: username || null,
                }
            : null;
        if (auth?.mode === "credentialHelper" && clonePassword) {
          await api.approveHttpsCredential(auth.credentialHost, remoteInfo.path, username, clonePassword);
          setClonePassword("");
        }
        const path = await api.cloneRepo(cloneRemoteUrl, dest, auth);
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
  }, [cloneUrl, cloneParent, cloneAccountId, cloneAuthAccounts, cloneUsername, clonePassword, remoteInfo, setScreen, setResult]);

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
    cloneAccountId,
    setCloneAccountId,
    cloneUsername,
    setCloneUsername,
    clonePassword,
    setClonePassword,
    cloneAuthAccounts,
    cloneRemoteInfo: remoteInfo,
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
