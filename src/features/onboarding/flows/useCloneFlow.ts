// Clone concern of the onboarding flow: the clone form (URL + destination), the
// streaming clone run with live progress, cancel, and retry. Owns only clone
// state; transitions the shared screen/result through the injected setters. The
// orchestrator (useOnboarding) composes this with useInitFlow.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
// eslint-disable-next-line no-restricted-imports -- feature hook owning the clone flow/session (architecture-rules-react.md §1)
import { api, type CloneProgress } from "../../../lib/api";
import { supportsProviderTokenAuth } from "../../../lib/forgeHelp";
import { repoLabel } from "../../../lib/paths";
import { detectRemoteUrl, forgeAuthProviderFor, withUrlUser } from "../../../lib/remotes";
import { pickProviderTokenForHost, useAccounts } from "../../../store/accounts";
import { readForgeCredentials } from "../../../store/accountsStorage";
import {
  canceledCloneCopy,
  classifyCloneError,
  type CloneErrorCopy,
  isSafeLeafName,
  joinPath,
  type OnboardingResult,
  type OnboardingScreen,
  parseRepoName,
  retryRerunsClone,
  validateCloneUrl,
} from "../onboarding";
import { cloneAuthStatusLine, cloneProviderFor, planCloneAuth } from "./cloneAuth";
import { defaultParent } from "./parents";

const INITIAL_PROGRESS: CloneProgress = { stage: "Connecting to remote", pct: 0 };

interface CloneFlowDeps {
  setScreen: (screen: OnboardingScreen) => void;
  setResult: (result: OnboardingResult) => void;
}

/** Explicit values for a recovery-screen transport switch (HTTPS↔SSH),
 * bypassing the async setState round-trip: the URL to clone is passed to
 * startClone directly because the form-field update hasn't landed yet. */
export interface CloneStartOverrides {
  url?: string;
}

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

  const url = useMemo(() => validateCloneUrl(cloneUrl), [cloneUrl]);
  const remoteInfo = useMemo(() => detectRemoteUrl(cloneUrl), [cloneUrl]);
  const accounts = useAccounts((s) => s.accounts);
  // The facts glab resolution depends on, selected as one primitive so the
  // auth-plan memo has an explicit reactive input (no array-identity churn, no
  // exhaustive-deps suppression): glab installed AND signed in, AND no saved
  // GitLab HTTPS credential overriding it. The override lives in localStorage,
  // but saving/forgetting one through the store re-sets forgeAuth (the
  // withSavedForgeCredentials mirror), so this selector re-runs then — the
  // same reactivity the old forgeAuth-array dependency provided.
  const glabUsable = useAccounts(
    (s) =>
      s.forgeAuth.some(
        (f) => f.provider === "gitlab" && f.cli === "glab" && f.available === true && f.authenticated === true,
      ) && readForgeCredentials()["gitlab"] === undefined,
  );
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
  // The resolved auth plan drives the form's "Will authenticate via …" status
  // line. Reactive mirrors of the sources startClone reads at run time via
  // getState(): providerTokens (keychain), forgeAuth (glab), the account pick,
  // and the manual fields — same inputs, same pure resolution, so the line can
  // never disagree with what the clone will actually do.
  const providerTokens = useAccounts((s) => s.providerTokens);
  const cloneAuthPlan = useMemo(() => {
    const httpsClone =
      remoteInfo.valid && !remoteInfo.ssh && !!remoteInfo.host && !!remoteInfo.credentialHost;
    return planCloneAuth({
      remoteInfo,
      selectedAccount: cloneAuthAccounts.find((a) => a.id === cloneAccountId) ?? null,
      username: cloneUsername.trim(),
      password: clonePassword,
      tokenForHost: httpsClone
        ? pickProviderTokenForHost(providerTokens, remoteInfo.credentialHost!)
        : undefined,
      // `glabUsable` is the reactive mirror of the forgeAuth fact
      // gitlabGlabAuth reads internally — gating on it keeps this memo's
      // dependency list exhaustive without suppression, and gitlabGlabAuth
      // still applies its saved-credential override on top.
      glabRef:
        httpsClone && glabUsable
          ? gitlabGlabAuth(remoteInfo.host!, remoteInfo.credentialHost!, cloneProviderFor(remoteInfo))
          : null,
    });
  }, [
    remoteInfo,
    cloneAuthAccounts,
    cloneAccountId,
    cloneUsername,
    clonePassword,
    providerTokens,
    glabUsable,
    gitlabGlabAuth,
  ]);
  const cloneAuthStatus = cloneAuthStatusLine(cloneAuthPlan);
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
    void (async () => {
      try {
        // A transport switch starts from the new transport's default auth —
        // form credentials belong to the URL they were entered for, so they
        // must not leak into the switched attempt (retryWithUrl also clears
        // the state; this covers the same tick's run).
        const switched = !!overrides?.url;
        const manualUsername = switched ? "" : cloneUsername.trim();
        const password = switched ? "" : clonePassword;
        const selectedAccount = switched
          ? null
          : (cloneAuthAccounts.find((a) => a.id === cloneAccountId) ?? null);
        const username = selectedAccount?.login ?? manualUsername;
        const cloneRemoteUrl =
          urlInfo.valid && !urlInfo.ssh && username
            ? withUrlUser(rawUrl.trim(), username)
            : rawUrl.trim();
        const cloneHost = urlInfo.host;
        const cloneCredHost = urlInfo.credentialHost;
        const httpsClone = urlInfo.valid && !urlInfo.ssh && !!cloneHost && !!cloneCredHost;
        // The same pure resolution the form's status line shows (cloneAuth.ts):
        // selected account > entered token > keychain token (GL-132/GL-139) >
        // glab (GL-139, same wiring as the Remotes panel) > bare username.
        const plan = planCloneAuth({
          remoteInfo: urlInfo,
          selectedAccount,
          username: manualUsername,
          password,
          tokenForHost:
            httpsClone && cloneCredHost
              ? pickProviderTokenForHost(useAccounts.getState().providerTokens, cloneCredHost)
              : undefined,
          glabRef:
            httpsClone && cloneHost && cloneCredHost
              ? useAccounts.getState().gitlabGlabAuth(cloneHost, cloneCredHost, cloneProviderFor(urlInfo))
              : null,
        });
        let auth = plan.auth;
        if (plan.method === "enteredToken" && auth) {
          // For a PR-capable forge, a token in GitLane's keychain powers both
          // git transport (via GIT_ASKPASS) and pull requests, and binds a PR
          // account — so the cloned repo opens PR-ready, not just fetch/push
          // ready (GL-152). The default is on; the recovery panel's checkbox can
          // opt back to the git helper (transport only, GitLane stores nothing).
          const forgeProvider = forgeAuthProviderFor(urlInfo.provider);
          // A keychain token is keyed by its account username, so this path needs
          // one; a blank-username token falls back to the git helper.
          let storedInKeychain = false;
          if (
            supportsProviderTokenAuth(forgeProvider) &&
            username &&
            (cloneKeychain ?? true) &&
            cloneCredHost &&
            cloneHost
          ) {
            // saveProviderToken toasts and returns false on an IPC/keychain
            // failure — only switch to providerToken mode when it truly landed,
            // else the clone would authenticate against a token that was never
            // stored and loop the same auth failure with no visible cause.
            storedInKeychain = await useAccounts
              .getState()
              .saveProviderToken(forgeProvider, cloneCredHost, username, password, { silent: true });
            if (storedInKeychain) {
              auth = {
                mode: "providerToken",
                provider: forgeProvider,
                host: cloneHost,
                credentialHost: cloneCredHost,
                username,
                providerAccountId: username,
              };
            }
          }
          if (!storedInKeychain) {
            // Save the typed token to the user's git helper, then clone through
            // it — the fallback when the keychain path didn't apply (helper opt-in,
            // blank username, non-PR forge) or its write failed. `auth` is still
            // the plan's credentialHelper ref here, so the clone stays consistent.
            await api.approveHttpsCredential(auth.credentialHost, urlInfo.path, username, password);
          }
          setClonePassword("");
        }
        const path = await api.cloneRepo(cloneRemoteUrl, dest, auth);
        if (cancelingRef.current) return;
        // Read the cloned repo so the confirmation shows its real branch/path.
        let name = parseRepoName(rawUrl);
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
  }, [cloneUrl, cloneParent, cloneFolder, cloneAccountId, cloneAuthAccounts, cloneUsername, clonePassword, cloneKeychain, remoteInfo, setScreen, setResult]);

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
