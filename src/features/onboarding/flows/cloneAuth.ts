// Pure clone-auth resolution: the single priority chain that decides how a
// clone authenticates — a selected gh account > an explicitly entered token >
// a GitLane keychain token > glab > a bare URL username > system credentials /
// SSH. Extracted from useCloneFlow's startClone so the clone form's "Will
// authenticate via …" status line and the actual clone can never disagree.
// No React, no IPC; unit-tested for parity in cloneAuth.test.ts.

import type { GitTransportAuthRef, GitTransportProvider } from "../../../lib/api";
import type { RemoteUrlInfo } from "../../../lib/remotes";

/** The slice of a gh account the resolution needs (store/accounts `Account`). */
export interface CloneAuthAccount {
  login: string;
  ref: NonNullable<GitTransportAuthRef["accountRef"]>;
}

/** The slice of a stored keychain token the resolution needs. */
export interface CloneAuthToken {
  provider: GitTransportProvider;
  accountId: string;
  login: string;
  transportUsername?: string | null;
}

export interface CloneAuthInputs {
  remoteInfo: RemoteUrlInfo;
  /** The gh account picked in the form (already resolved from its id). */
  selectedAccount: CloneAuthAccount | null;
  /** Trimmed manual username ("" = none). */
  username: string;
  /** Manual token/password ("" = none). */
  password: string;
  /** GitLane-owned keychain token for the URL's credential host, if any. */
  tokenForHost: CloneAuthToken | undefined;
  /** glab-backed auth ref for a GitLab host, if glab is signed in. */
  glabRef: GitTransportAuthRef | null;
}

export type CloneAuthMethod =
  | "account" // a connected gh account
  | "enteredToken" // token typed into the form → saved to the git helper
  | "keychain" // GitLane-owned keychain token (OAuth/PAT)
  | "glab" // GitLab CLI credential
  | "system" // system git credential helpers (with or without a URL username)
  | "ssh"; // SSH key + agent

export interface CloneAuthPlan {
  auth: GitTransportAuthRef | null;
  method: CloneAuthMethod;
  /** The identity the status line names (@login / URL username), if any. */
  login: string | null;
}

/** The provider a clone URL maps to on a transport auth ref. */
export function cloneProviderFor(remoteInfo: RemoteUrlInfo): GitTransportProvider {
  return remoteInfo.provider === "azure"
    ? "azure-devops"
    : remoteInfo.provider === "github" ||
        remoteInfo.provider === "gitlab" ||
        remoteInfo.provider === "bitbucket"
      ? remoteInfo.provider
      : "other";
}

/** Resolve how a clone of `remoteInfo` would authenticate. Priority order is
 * the contract: selected account > entered token > keychain token > glab >
 * bare username > system/SSH. */
export function planCloneAuth(inputs: CloneAuthInputs): CloneAuthPlan {
  const { remoteInfo, selectedAccount, username, password, tokenForHost, glabRef } = inputs;
  if (remoteInfo.valid && remoteInfo.ssh) return { auth: null, method: "ssh", login: null };

  const host = remoteInfo.host;
  const credentialHost = remoteInfo.credentialHost;
  const httpsClone = remoteInfo.valid && !remoteInfo.ssh && !!host && !!credentialHost;
  if (!httpsClone || !host || !credentialHost) return { auth: null, method: "system", login: null };

  const provider = cloneProviderFor(remoteInfo);
  if (selectedAccount) {
    return {
      auth: {
        mode: "githubGh",
        provider: "github",
        host,
        credentialHost,
        username: selectedAccount.login,
        accountRef: selectedAccount.ref,
      },
      method: "account",
      login: selectedAccount.login,
    };
  }
  if (password) {
    // An explicitly entered token wins — saved to the git helper, then used.
    return {
      auth: { mode: "credentialHelper", provider, host, credentialHost, username: username || null },
      method: "enteredToken",
      login: username || null,
    };
  }
  if (tokenForHost) {
    return {
      auth: {
        mode: "providerToken",
        provider: tokenForHost.provider,
        host,
        credentialHost,
        username: tokenForHost.transportUsername ?? tokenForHost.login,
        providerAccountId: tokenForHost.accountId,
      },
      method: "keychain",
      login: tokenForHost.login,
    };
  }
  if (glabRef) {
    return { auth: glabRef, method: "glab", login: glabRef.username ?? null };
  }
  if (username) {
    return {
      auth: { mode: "credentialHelper", provider, host, credentialHost, username },
      method: "system",
      login: username,
    };
  }
  return { auth: null, method: "system", login: null };
}

/** The clone form's one-line auth status for a resolved plan. */
export function cloneAuthStatusLine(plan: CloneAuthPlan): string {
  switch (plan.method) {
    case "ssh":
      return "SSH — authenticates with your SSH key.";
    case "account":
      return `Will authenticate as @${plan.login} via gh.`;
    case "enteredToken":
      return "Will authenticate with the token you entered.";
    case "keychain":
      return `Will authenticate as @${plan.login} via the GitLane keychain.`;
    case "glab":
      return "Signed in via glab — authenticates automatically.";
    case "system":
      return plan.login
        ? `Will authenticate as ${plan.login} via your system git credentials.`
        : "Will use your system git credentials if the repository is private.";
  }
}
