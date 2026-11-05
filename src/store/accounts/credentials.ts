// Secrets: the user's own Git credential-helper entries (`git credential
// approve`/`reject`) and GitLane-owned keychain tokens (GL-132). Two distinct
// verbs live here — provider **sign-out** deletes GitLane's keychain token,
// **forget saved HTTPS credential** erases what the user's own helper stored.
// No secret is ever kept in app state: a token crosses IPC once on its way to
// the keychain / helper, and only non-secret metadata comes back.

import { api, type ForgeAuthProvider, type ForgeAuthStatus, type GitTransportAuthRef, type TokenProvider } from "@/lib/api";
import { credentialScopePath, detectRemoteUrl, transportProviderForForgeAuth } from "@/lib/remotes";
import {
  captureRepoMutationTarget,
  type RepoBindingKeyRead,
} from "@/store/accounts/repoMutation";
import {
  providerTokenKey,
  readForgeCredentials,
  readProviderTokens,
  writeProviderTokens,
  type StoredProviderToken,
} from "@/store/accountsStorage";
import {
  forgetForgeCredential,
  rememberForgeCredential,
  withSavedForgeCredentials,
} from "@/store/forgeCredentials";
import {
  checkHostRemotes,
  everyCheckRejected,
  failedOutcome,
  helperCheckRef,
  providerTokenCheckRef,
  remoteSpellingFor,
  type CredentialSaveOutcome,
} from "@/store/accounts/credentialChecks";
import { friendlyGitError } from "@/lib/gitError";
import { storeLinks } from "@/store/links";
import type { SliceSet } from "@/store/slice";
import { refreshToolProbes } from "@/store/toolProbes";
import { useUi } from "@/store/ui";

export interface CredentialsSlice {
  /** GitLane-owned provider tokens by `credentialHost login` key (GL-132). Backs
   * `providerToken` transport selection and the keychain sign-out UI. Non-secret
   * metadata only — the token itself lives in the OS keychain. */
  providerTokens: Record<string, StoredProviderToken>;

  /** Store an HTTPS token/password in Git's configured credential helper, then
   * check the open repo's remotes on that host. The outcome is for the form to
   * render inline — no toast (Settings is a modal over the toast layer). */
  saveHttpsCredential: (
    credentialHost: string,
    path: string | null,
    username: string,
    password: string,
    provider?: ForgeAuthProvider,
  ) => Promise<CredentialSaveOutcome>;
  /** Store a remote's HTTPS token/password, write its username into the URL
   * (one value for both), then check the open repo's remotes on that host. */
  saveRemoteCredential: (remote: string, username: string, password: string) => Promise<CredentialSaveOutcome>;
  /** Store a pasted token as GitLane's own transport token for `provider`
   * (keychain + askpass bridge, which ignores the user's credential helpers),
   * then check the open repo's remotes on that host with that token. A token
   * every checked remote refuses is removed again and any token it would
   * replace is kept, so a bad paste never shadows the helper or costs a
   * working token. */
  saveTransportToken: (
    provider: TokenProvider,
    credentialHost: string,
    login: string,
    token: string,
  ) => Promise<CredentialSaveOutcome>;
  /** [`saveTransportToken`] for GitHub. */
  saveGithubToken: (credentialHost: string, login: string, token: string) => Promise<CredentialSaveOutcome>;
  /** Store a provider account's transport token in the OS keychain (GL-132) and
   * remember its non-secret metadata. The token is sent once and never returned.
   * After this, `transportAuthForRemote` selects `providerToken` for remotes
   * whose URL username matches. Resolves `true` when the token reached the
   * keychain, `false` on a validation/IPC failure (already toasted) — callers
   * that then switch auth to `providerToken` mode must check this so a failed
   * write doesn't leave them pointing at a token that was never stored. */
  saveProviderToken: (
    provider: TokenProvider,
    credentialHost: string,
    login: string,
    token: string,
  ) => Promise<boolean>;
  /** Provider **sign-out**: delete a GitLane-owned keychain token and forget its
   * metadata. Distinct from [`forgetHttpsCredential`] — this removes GitLane's
   * own secret and leaves the user's git credential-helper credentials alone. */
  signOutProviderToken: (
    provider: TokenProvider,
    credentialHost: string,
    login: string,
  ) => Promise<void>;
  /** **Forget saved HTTPS credential**: ask Git's credential helper to erase a
   * saved credential (`git credential reject`). Distinct from provider sign-out —
   * this touches only the user's helper, not a GitLane-owned keychain token.
   * Resolves `null` once the helper accepted the erase, else the error message.
   * A failure is toasted unless `inline` (the caller renders it, e.g. inside
   * the Settings modal, where a toast would sit underneath). */
  forgetHttpsCredential: (
    credentialHost: string,
    path: string | null,
    username: string,
    provider?: ForgeAuthProvider,
    inline?: boolean,
  ) => Promise<string | null>;
  /** Sign out of a saved-credential forge (no CLI, e.g. Bitbucket): look up the
   * saved HTTPS credential and forget it (git credential reject + drop the local
   * marker), so the connected-account card offers sign-out for CLI-less providers. */
  signOutForgeCredential: (provider: ForgeAuthProvider) => Promise<void>;
  /** Prune keychain-token metadata that no longer has a backing secret — e.g. a
   * token deleted outside GitLane (Keychain Access, `secret-tool`). Best-effort,
   * so a transient keychain error never drops a still-valid entry. Keeps the
   * "signed in" UI + `providerToken` selection honest. */
  reconcileProviderTokens: () => Promise<void>;
}

/** Saving/forgetting a credential re-derives the "saved credential" marker the
 * forge-auth rows render, so this slice writes that one foreign field. */
type CredentialsSet = SliceSet<CredentialsSlice & { forgeAuth: ForgeAuthStatus[] }>;

type TransportAuthRead = {
  transportAuthForRemote: (remote: string, direction?: "fetch" | "push") => GitTransportAuthRef | null;
};

export function createCredentialsSlice(
  set: CredentialsSet,
  get: () => CredentialsSlice & RepoBindingKeyRead & TransportAuthRead,
): CredentialsSlice {
  /** Check a helper save through the helper, whatever a fetch would pick. */
  const checkHelper = (credentialHost: string, only?: string) =>
    checkHostRemotes(
      credentialHost,
      helperCheckRef((remote) => get().transportAuthForRemote(remote, "fetch")),
      only,
    );

  /** Write a provider token to the keychain and record its metadata; the
   * caught error, or `null` once stored. */
  const storeProviderToken = async (
    provider: TokenProvider,
    host: string,
    user: string,
    token: string,
  ): Promise<unknown> => {
    // For a personal-access-token sign-in the login is the stable account id.
    const accountId = user;
    // An account add re-probes the CLIs (a glab installed since launch).
    await refreshToolProbes();
    try {
      // The token crosses IPC exactly once, straight into the OS keychain; only
      // non-secret status comes back.
      await api.saveProviderToken(provider, host, accountId, user, token);
      const entry: StoredProviderToken = { provider, credentialHost: host, accountId, login: user, savedAt: Date.now() };
      const next = { ...get().providerTokens, [providerTokenKey(host, user)]: entry };
      writeProviderTokens(next);
      set({ providerTokens: next });
      return null;
    } catch (e) {
      return e;
    }
  };

  return {
    providerTokens: readProviderTokens(),

    saveHttpsCredential: async (credentialHost, path, username, password, provider) => {
      const cleanHost = credentialHost.trim();
      if (!cleanHost) return failedOutcome("Credential host is missing.");
      if (!username.trim()) return failedOutcome("Enter the HTTPS username for this provider.");
      if (!password) return failedOutcome("Enter the token or password.");
      // Git looks the credential up by the remote URL's exact username, so a
      // case-only difference saves under the URL's spelling.
      const spelling = remoteSpellingFor(cleanHost, username.trim());
      const cleanUser = spelling ?? username.trim();
      try {
        const result = await api.approveHttpsCredential(cleanHost, path, cleanUser, password);
        if (provider) {
          rememberForgeCredential(provider, cleanHost, path, result.username, result.helper);
          set((s) => ({
            forgeAuth: withSavedForgeCredentials(s.forgeAuth),
          }));
        }
        const note = spelling ? `Saved for @${spelling}, the spelling your remote URL uses.` : null;
        return { ok: true, checks: await checkHelper(cleanHost), note };
      } catch (e) {
        return failedOutcome(e);
      }
    },

    saveRemoteCredential: async (remote, username, password) => {
      // Pinned to the repo that started the save (GL-167) — see setRemoteAccount.
      const ctx = captureRepoMutationTarget(get().repoBindingKey, remote);
      const target = ctx.remote;
      if (!target) return failedOutcome(`Remote ${remote} is no longer configured.`);
      const info = detectRemoteUrl(target.pushUrl || target.fetchUrl);
      if (!info.valid || info.ssh || !info.credentialHost) {
        return failedOutcome(`${remote} must be an HTTPS remote to save credentials.`);
      }
      const clean = username.trim();
      if (!clean) return failedOutcome("Enter the HTTPS username for this remote.");
      if (!password) return failedOutcome("Enter the token or password.");
      try {
        // Azure Repos uses the exact URL path with credential.useHttpPath=true;
        // other providers use Git's normal host-only matching.
        const scopePath = credentialScopePath(info);
        await api.approveHttpsCredential(info.credentialHost, scopePath, clean, password);
        // The captured repo's remote, not the then-current one (GL-167).
        await api.setRemoteUsername(ctx.path, remote, clean);
        if (!ctx.isCurrent()) {
          return { ok: true, checks: [], note: "Saved. Not checked, because another repository was opened meanwhile." };
        }
        await storeLinks.listRemotes();
        return { ok: true, checks: await checkHelper(info.credentialHost, remote), note: null };
      } catch (e) {
        return failedOutcome(e);
      }
    },

    saveGithubToken: (credentialHost, login, token) => get().saveTransportToken("github", credentialHost, login, token),

    saveTransportToken: async (provider, credentialHost, login, token) => {
      const host = credentialHost.trim();
      const user = login.trim();
      if (!host) return failedOutcome("Credential host is missing.");
      if (!user) return failedOutcome(provider === "github" ? "Enter your GitHub username." : "Enter the HTTPS username.");
      if (!token.trim()) return failedOutcome(provider === "github" ? "Paste a personal access token." : "Paste an access token.");
      // Stage under a fresh keychain id when a token for this account exists,
      // so a rejected paste can be dropped without losing the working one.
      // A token for the same account under another case would otherwise keep
      // winning the exact-key lookup at fetch time, so it is the one replaced.
      const priorKey = Object.keys(get().providerTokens).find((key) => {
        const t = get().providerTokens[key];
        return (
          t.provider === provider &&
          t.credentialHost.toLowerCase() === host.toLowerCase() &&
          t.login.toLowerCase() === user.toLowerCase()
        );
      });
      const prior = priorKey ? get().providerTokens[priorKey] : undefined;
      const accountId = prior ? `${user}#${Date.now()}` : user;
      try {
        // The token crosses IPC exactly once, straight into the OS keychain.
        await api.saveProviderToken(provider, host, accountId, user, token);
      } catch (e) {
        return failedOutcome(e);
      }
      const checks = await checkHostRemotes(
        host,
        providerTokenCheckRef(transportProviderForForgeAuth(provider), user, accountId),
      );
      if (everyCheckRejected(checks)) {
        await api.deleteProviderToken(provider, host, accountId).catch(() => {});
        const first = checks[0];
        const kept = prior ? " Your previous token is still saved." : "";
        return {
          ...failedOutcome(`${host} did not accept this token.${kept} ${first.ok ? "" : first.message}`.trim()),
          detail: first.ok ? null : first.detail,
        };
      }
      const entry: StoredProviderToken = { provider, credentialHost: host, accountId, login: user, savedAt: Date.now() };
      const next = { ...get().providerTokens };
      if (priorKey) delete next[priorKey];
      next[providerTokenKey(host, user)] = entry;
      writeProviderTokens(next);
      set({ providerTokens: next });
      if (prior && prior.accountId !== accountId) {
        await api.deleteProviderToken(prior.provider, prior.credentialHost, prior.accountId).catch(() => {});
      }
      return { ok: true, checks, note: null };
    },

    saveProviderToken: async (provider, credentialHost, login, token) => {
      const host = credentialHost.trim();
      const user = login.trim();
      if (!host) {
        useUi.getState().showToast("Credential host is missing.", "error");
        return false;
      }
      if (!user) {
        useUi.getState().showToast("Enter the account username for this token.", "error");
        return false;
      }
      if (!token) {
        useUi.getState().showToast("Enter the token to store in your keychain.", "error");
        return false;
      }
      const error = await storeProviderToken(provider, host, user, token);
      if (error === null) return true;
      useUi.getState().showToast(error, "error");
      return false;
    },

    signOutProviderToken: async (provider, credentialHost, login) => {
      const host = credentialHost.trim();
      // `login` here is the entry's key component — the transport username (a
      // sentinel for OAuth accounts, the handle for PAT accounts). Resolve the
      // real keychain locator from the stored entry so an OAuth token (keyed by
      // its provider account id, not the sentinel) is deleted correctly; fall back
      // to the username for a legacy entry with no recorded id.
      const key = providerTokenKey(host, login);
      const entry = get().providerTokens[key];
      const accountId = entry?.accountId ?? login.trim();
      // An account remove re-probes the CLIs, like every account change.
      await refreshToolProbes();
      try {
        await api.deleteProviderToken(provider, host, accountId);
        const next = { ...get().providerTokens };
        delete next[key];
        writeProviderTokens(next);
        set({ providerTokens: next });
      } catch (e) {
        useUi.getState().showToast(e, "error");
      }
    },

    forgetHttpsCredential: async (credentialHost, path, username, provider, inline = false) => {
      const host = credentialHost.trim();
      const user = username.trim();
      const fail = (error: unknown) => {
        if (!inline) useUi.getState().showToast(error, "error");
        return typeof error === "string" ? error : friendlyGitError(error, { credentialHelp: "generic" });
      };
      if (!host) return fail("Credential host is missing.");
      if (!user) return fail("Enter the HTTPS username to forget.");
      try {
        await api.rejectHttpsCredential(host, path, user);
        if (provider) {
          forgetForgeCredential(provider);
          set((s) => ({ forgeAuth: withSavedForgeCredentials(s.forgeAuth) }));
        }
        return null;
      } catch (e) {
        return fail(e);
      }
    },

    signOutForgeCredential: async (provider) => {
      const saved = readForgeCredentials()[provider];
      if (!saved) {
        // No local record left — just clear any stale "signed in" marker.
        forgetForgeCredential(provider);
        set((s) => ({ forgeAuth: withSavedForgeCredentials(s.forgeAuth) }));
        return;
      }
      await get().forgetHttpsCredential(saved.credentialHost, saved.path, saved.username, provider);
    },

    reconcileProviderTokens: async () => {
      const entries = Object.entries(get().providerTokens);
      if (entries.length === 0) return;
      // Ask the backend (keychain is authoritative) which tokens still exist. A
      // check that throws is treated as "keep" — never prune on a transient error.
      const results = await Promise.all(
        entries.map(async ([key, t]) => {
          try {
            const status = await api.providerTokenStatus(t.provider, t.credentialHost, t.accountId, t.login);
            return status.hasToken ? null : ([key, t] as const);
          } catch {
            return null;
          }
        }),
      );
      const stale = results.filter((r): r is readonly [string, StoredProviderToken] => r !== null);
      if (stale.length === 0) return;
      // Compare-and-delete (GL-168): drop a key only while its entry is still the
      // exact object that was probed. Every writer builds a fresh entry object, so
      // identity pins the probe to one generation of metadata — a sign-in that
      // replaced the key mid-probe (its keychain token DOES exist) survives, and
      // the overlapping reconciles the Accounts panel triggers stay idempotent
      // (the second run's delete no-ops on the already-removed entry).
      const next = { ...get().providerTokens };
      let changed = false;
      for (const [key, probed] of stale) {
        if (next[key] !== probed) continue;
        delete next[key];
        changed = true;
      }
      if (!changed) return;
      writeProviderTokens(next);
      set({ providerTokens: next });
    },
  };
}
