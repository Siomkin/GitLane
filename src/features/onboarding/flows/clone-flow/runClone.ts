// The clone run itself: resolve the auth plan the form already showed, persist
// an entered token where it belongs (GitLane keychain or the user's git
// helper), stream the clone, then open the result. Extracted verbatim from
// useCloneFlow's startClone so the hook stays a thin state/callback shell.

// eslint-disable-next-line no-restricted-imports -- feature hook owning the clone flow/session (architecture-rules-react.md §1)
import { api } from "@/lib/api";
import { supportsProviderTokenAuth } from "@/lib/forgeHelp";
import { repoLabel } from "@/lib/paths";
import {
  credentialScopePath,
  forgeAuthProviderFor,
  transportProviderForForgeAuth,
  type RemoteUrlInfo,
  withUrlUser,
} from "@/lib/remotes";
import { pickProviderTokenForHost, useAccounts, type Account } from "@/store/accounts";
import {
  classifyCloneError,
  type CloneErrorCopy,
  type OnboardingResult,
  type OnboardingScreen,
  parseRepoName,
} from "@/features/onboarding/onboarding";
import { cloneProviderFor, planCloneAuth, toCloneAuthToken } from "@/features/onboarding/flows/cloneAuth";

/** Explicit values for a recovery-screen transport switch (HTTPS↔SSH),
 * bypassing the async setState round-trip: the URL to clone is passed to
 * startClone directly because the form-field update hasn't landed yet. */
export interface CloneStartOverrides {
  url?: string;
}

export interface RunCloneInputs {
  overrides: CloneStartOverrides | undefined;
  /** The URL being cloned (the override's, or the form field's). */
  rawUrl: string;
  urlInfo: RemoteUrlInfo;
  /** Absolute destination path (parent + leaf), already validated. */
  dest: string;
  cloneUsername: string;
  clonePassword: string;
  cloneAccountId: string | null;
  cloneAuthAccounts: Account[];
  cloneKeychain: boolean | null;
  cancelingRef: { current: boolean };
  cloningRef: { current: boolean };
  setClonePassword: (password: string) => void;
  setError: (error: CloneErrorCopy | null) => void;
  setScreen: (screen: OnboardingScreen) => void;
  setResult: (result: OnboardingResult) => void;
}

export const runClone = async ({
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
}: RunCloneInputs): Promise<void> => {
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
          ? toCloneAuthToken(pickProviderTokenForHost(useAccounts.getState().providerTokens, cloneCredHost))
          : undefined,
      glabRef:
        httpsClone && cloneHost && cloneCredHost
          ? useAccounts.getState().gitlabGlabAuth(cloneHost, cloneCredHost, cloneProviderFor(urlInfo))
          : null,
    });
    let auth = plan.auth;
    if (plan.method === "enteredToken" && auth) {
      const enteredAuth = auth;
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
        // saveProviderToken returns false on an IPC/keychain failure —
        // only switch to providerToken mode when it truly landed, else the
        // clone would authenticate against a token that was never stored
        // and loop the same auth failure with no visible cause.
        storedInKeychain = await useAccounts
          .getState()
          .saveProviderToken(forgeProvider, cloneCredHost, username, password);
        if (storedInKeychain) {
          auth = {
            mode: "providerToken",
            provider: transportProviderForForgeAuth(forgeProvider),
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
        await api.approveHttpsCredential(
          enteredAuth.credentialHost,
          credentialScopePath(urlInfo),
          username,
          password,
        );
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
};
