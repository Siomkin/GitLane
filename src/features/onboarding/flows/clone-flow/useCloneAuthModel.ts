// The clone form's derived auth model: URL validation/detection, the accounts
// eligible for the detected host, and the resolved auth plan + status line.
// Extracted from useCloneFlow as one contiguous block of hooks, so hook order
// is unchanged; the facade calls it in the same position.

import { useEffect, useMemo } from "react";
import { detectRemoteUrl } from "@/lib/remotes";
import { pickProviderTokenForHost, useAccounts } from "@/store/accounts";
import { readForgeCredentials } from "@/store/accountsStorage";
import { validateCloneUrl } from "@/features/onboarding/onboarding";
import {
  cloneAuthStatusLine,
  cloneProviderFor,
  planCloneAuth,
} from "@/features/onboarding/flows/cloneAuth";

interface CloneAuthModelInputs {
  cloneUrl: string;
  cloneAccountId: string | null;
  cloneUsername: string;
  clonePassword: string;
}

export const useCloneAuthModel = ({
  cloneUrl,
  cloneAccountId,
  cloneUsername,
  clonePassword,
}: CloneAuthModelInputs) => {
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

  return { url, remoteInfo, cloneAuthAccounts, cloneAuthPlan, cloneAuthStatus };
};
