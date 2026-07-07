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
import { pickProviderTokenForHost, useAccounts } from "../../../store/accounts";
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
  const forgeAuth = useAccounts((s) => s.forgeAuth);
  const gitlabGlabAuth = useAccounts((s) => s.gitlabGlabAuth);
  const loadForgeAuth = useAccounts((s) => s.loadForgeAuth);
  // Detect a glab sign-in in the clone context too — otherwise `forgeAuth` is only
  // ever populated by the Accounts/Remotes panels, and a GitLab clone opened
  // straight from onboarding would neither wire glab nor show its hint (GL-139).
  // Non-forced, so it defers to an already-loaded list.
  useEffect(() => {
    void loadForgeAuth();
  }, [loadForgeAuth]);
  const cloneAuthAccounts = useMemo(
    () =>
      remoteInfo.valid && !remoteInfo.ssh && remoteInfo.credentialHost
        ? accounts.filter(
            (a) =>
              a.host === remoteInfo.credentialHost ||
              // Mirror accountMatchesRemoteHost: a `www.` remote still matches the
              // bare-host account (GL-129), so the picker doesn't drop it.
              (remoteInfo.credentialHost!.startsWith("www.") && a.host === remoteInfo.host),
          )
        : [],
    [accounts, remoteInfo.credentialHost, remoteInfo.host, remoteInfo.ssh, remoteInfo.valid],
  );
  // Whether this GitLab clone would authenticate through glab automatically —
  // so the form can say the token fields are optional (GL-139).
  const cloneGlabReady = useMemo(
    () =>
      remoteInfo.provider === "gitlab" &&
      !remoteInfo.ssh &&
      !!remoteInfo.host &&
      !!remoteInfo.credentialHost &&
      gitlabGlabAuth(remoteInfo.host, remoteInfo.credentialHost, "gitlab") !== null,
    [remoteInfo, forgeAuth, gitlabGlabAuth],
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
        const cloneHost = remoteInfo.host;
        const cloneCredHost = remoteInfo.credentialHost;
        const httpsClone = remoteInfo.valid && !remoteInfo.ssh && !!cloneHost && !!cloneCredHost;
        // Same glab wiring the Remotes panel uses: a GitLab clone with glab signed
        // in authenticates with no token entered (GL-139).
        const glabRef =
          httpsClone && cloneHost && cloneCredHost
            ? useAccounts.getState().gitlabGlabAuth(cloneHost, cloneCredHost, provider)
            : null;
        // A GitLane-owned keychain token (OAuth/PAT) for this host authenticates
        // the clone with nothing entered (GL-132/GL-139), just like transport.
        const tokenForHost =
          httpsClone && cloneCredHost
            ? pickProviderTokenForHost(useAccounts.getState().providerTokens, cloneCredHost)
            : undefined;
        let auth: GitTransportAuthRef | null = null;
        if (httpsClone && cloneHost && cloneCredHost) {
          if (selectedAccount) {
            auth = {
              mode: "githubGh",
              provider: "github",
              host: cloneHost,
              credentialHost: cloneCredHost,
              username,
              accountRef: selectedAccount.ref,
            };
          } else if (clonePassword) {
            // An explicitly entered token wins — save it to the git helper, use it.
            auth = {
              mode: "credentialHelper",
              provider,
              host: cloneHost,
              credentialHost: cloneCredHost,
              username: username || null,
            };
          } else if (tokenForHost) {
            auth = {
              mode: "providerToken",
              provider: tokenForHost.provider,
              host: cloneHost,
              credentialHost: cloneCredHost,
              username: tokenForHost.transportUsername ?? tokenForHost.login,
              providerAccountId: tokenForHost.accountId,
            };
          } else if (glabRef) {
            auth = glabRef;
          } else if (username) {
            auth = {
              mode: "credentialHelper",
              provider,
              host: cloneHost,
              credentialHost: cloneCredHost,
              username,
            };
          }
        }
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
    cloneGlabReady,
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
