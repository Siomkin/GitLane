// Secrets: the user's own Git credential-helper entries (`git credential
// approve`/`reject`) and GitLane-owned keychain tokens (GL-132). Two distinct
// verbs live here — provider **sign-out** deletes GitLane's keychain token,
// **forget saved HTTPS credential** erases what the user's own helper stored.
// No secret is ever kept in app state: a token crosses IPC once on its way to
// the keychain / helper, and only non-secret metadata comes back.

import { api, type ForgeAuthProvider, type ForgeAuthStatus } from "@/lib/api";
import { credentialScopePath, detectRemoteUrl, forgeAuthProviderFor } from "@/lib/remotes";
import { captureRepoMutationTarget } from "@/store/accounts/repoMutation";
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
import { useRepo } from "@/store/repo";
import type { SliceSet } from "@/store/slice";
import { useUi } from "@/store/ui";

export interface CredentialsSlice {
  /** GitLane-owned provider tokens by `credentialHost login` key (GL-132). Backs
   * `providerToken` transport selection and the keychain sign-out UI. Non-secret
   * metadata only — the token itself lives in the OS keychain. */
  providerTokens: Record<string, StoredProviderToken>;

  /** Store an HTTPS token/password in Git's configured credential helper. */
  saveHttpsCredential: (
    credentialHost: string,
    path: string | null,
    username: string,
    password: string,
    provider?: ForgeAuthProvider,
  ) => Promise<boolean>;
  /** Store a remote's HTTPS token/password and write its username into the URL. */
  saveRemoteCredential: (remote: string, username: string, password: string) => Promise<boolean>;
  /** True when a GitLane-owned keychain token is stored for `credentialHost` +
   * `login`. Drives the transport `providerToken` mode and the sign-out control. */
  hasProviderToken: (credentialHost: string, login: string) => boolean;
  /** Store a provider account's transport token in the OS keychain (GL-132) and
   * remember its non-secret metadata. The token is sent once and never returned.
   * After this, `transportAuthForRemote` selects `providerToken` for remotes
   * whose URL username matches. Resolves `true` when the token reached the
   * keychain, `false` on a validation/IPC failure (already toasted) — callers
   * that then switch auth to `providerToken` mode must check this so a failed
   * write doesn't leave them pointing at a token that was never stored. */
  saveProviderToken: (
    provider: ForgeAuthProvider,
    credentialHost: string,
    login: string,
    token: string,
  ) => Promise<boolean>;
  /** Store a keychain token **for a specific remote** and pin `login` into the
   * remote's HTTPS URL, so `transportAuthForRemote` immediately selects
   * `providerToken` — even for a bare `https://host/owner/repo.git` URL with no
   * embedded username. The git-native username is the account selector. Kept for
   * the OAuth flow and Accounts-page keychain management (the per-remote
   * credential-entry UI was removed — remotes only *select* an account). */
  saveRemoteProviderToken: (remote: string, login: string, token: string) => Promise<void>;
  /** Provider **sign-out**: delete a GitLane-owned keychain token and forget its
   * metadata. Distinct from [`forgetHttpsCredential`] — this removes GitLane's
   * own secret and leaves the user's git credential-helper credentials alone. */
  signOutProviderToken: (
    provider: ForgeAuthProvider,
    credentialHost: string,
    login: string,
  ) => Promise<void>;
  /** **Forget saved HTTPS credential**: ask Git's credential helper to erase a
   * saved credential (`git credential reject`). Distinct from provider sign-out —
   * this touches only the user's helper, not a GitLane-owned keychain token. */
  forgetHttpsCredential: (
    credentialHost: string,
    path: string | null,
    username: string,
    provider?: ForgeAuthProvider,
  ) => Promise<void>;
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

export function createCredentialsSlice(
  set: CredentialsSet,
  get: () => CredentialsSlice,
): CredentialsSlice {
  return {
    providerTokens: readProviderTokens(),

    saveHttpsCredential: async (credentialHost, path, username, password, provider) => {
      const cleanUser = username.trim();
      const cleanHost = credentialHost.trim();
      if (!cleanHost) {
        useUi.getState().showToast("Credential host is missing.", "error");
        return false;
      }
      if (!cleanUser) {
        useUi.getState().showToast("Enter the HTTPS username for this provider.", "error");
        return false;
      }
      if (!password) {
        useUi.getState().showToast("Enter the token or password.", "error");
        return false;
      }
      try {
        const result = await api.approveHttpsCredential(cleanHost, path, cleanUser, password);
        if (provider) {
          rememberForgeCredential(provider, cleanHost, path, result.username, result.helper);
          set((s) => ({
            forgeAuth: withSavedForgeCredentials(s.forgeAuth),
          }));
        }
        return true;
      } catch (e) {
        useUi.getState().showToast(e, "error");
        return false;
      }
    },

    saveRemoteCredential: async (remote, username, password) => {
      // Pinned to the repo that started the save (GL-167) — see setRemoteAccount.
      const ctx = captureRepoMutationTarget(remote);
      const target = ctx.remote;
      if (!target) return false;
      const info = detectRemoteUrl(target.pushUrl || target.fetchUrl);
      if (!info.valid || info.ssh || !info.credentialHost) {
        useUi
          .getState()
          .showToast(`${remote} must be an HTTPS remote to save credentials.`, "error");
        return false;
      }
      const clean = username.trim();
      if (!clean) {
        useUi.getState().showToast("Enter the HTTPS username for this remote.", "error");
        return false;
      }
      if (!password) {
        useUi.getState().showToast("Enter the token or password.", "error");
        return false;
      }
      try {
        // Azure Repos uses the exact URL path with credential.useHttpPath=true;
        // other providers use Git's normal host-only matching.
        const scopePath = credentialScopePath(info);
        await api.approveHttpsCredential(info.credentialHost, scopePath, clean, password);
        // The captured repo's remote, not the then-current one (GL-167).
        await api.setRemoteUsername(ctx.path, remote, clean);
        if (!ctx.isCurrent()) return true;
        await useRepo.getState().listRemotes();
        return true;
      } catch (e) {
        useUi.getState().showToast(e, "error");
        return false;
      }
    },

    hasProviderToken: (credentialHost, login) =>
      get().providerTokens[providerTokenKey(credentialHost, login)] !== undefined,

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
      // For a personal-access-token sign-in the login is the stable account id.
      const accountId = user;
      try {
        // The token crosses IPC exactly once, straight into the OS keychain; only
        // non-secret status comes back.
        await api.saveProviderToken(provider, host, accountId, user, token);
        const entry: StoredProviderToken = {
          provider,
          credentialHost: host,
          accountId,
          login: user,
          savedAt: Date.now(),
        };
        const next = { ...get().providerTokens, [providerTokenKey(host, user)]: entry };
        writeProviderTokens(next);
        set({ providerTokens: next });
        return true;
      } catch (e) {
        useUi.getState().showToast(e, "error");
        return false;
      }
    },

    saveRemoteProviderToken: async (remote, login, token) => {
      // Pinned to the repo that started the save (GL-167) — see setRemoteAccount.
      const ctx = captureRepoMutationTarget(remote);
      const target = ctx.remote;
      if (!target) return;
      const info = detectRemoteUrl(target.pushUrl || target.fetchUrl);
      const provider = forgeAuthProviderFor(info.provider);
      if (!info.valid || info.ssh || !info.credentialHost || !provider) {
        useUi
          .getState()
          .showToast(`${remote} isn't a supported HTTPS remote for a keychain token.`, "error");
        return;
      }
      const user = login.trim();
      if (!user) {
        useUi.getState().showToast("Enter the account username for this token.", "error");
        return;
      }
      if (!token) {
        useUi.getState().showToast("Enter the token to store in your keychain.", "error");
        return;
      }
      const host = info.credentialHost;
      const accountId = user;
      try {
        await api.saveProviderToken(provider, host, accountId, user, token);
        const entry: StoredProviderToken = {
          provider,
          credentialHost: host,
          accountId,
          login: user,
          savedAt: Date.now(),
        };
        const next = { ...get().providerTokens, [providerTokenKey(host, user)]: entry };
        writeProviderTokens(next);
        set({ providerTokens: next });
        // Pin the account into the remote URL — the git-native account selector —
        // so fetch/push actually resolve `providerToken` mode. Without this a
        // bare `https://host/owner/repo.git` would keep using system credentials.
        // The captured repo's remote, not the then-current one (GL-167).
        await api.setRemoteUsername(ctx.path, remote, user);
        if (!ctx.isCurrent()) return;
        await useRepo.getState().listRemotes();
      } catch (e) {
        useUi.getState().showToast(e, "error");
      }
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

    forgetHttpsCredential: async (credentialHost, path, username, provider) => {
      const host = credentialHost.trim();
      const user = username.trim();
      if (!host) {
        useUi.getState().showToast("Credential host is missing.", "error");
        return;
      }
      if (!user) {
        useUi.getState().showToast("Enter the HTTPS username to forget.", "error");
        return;
      }
      try {
        await api.rejectHttpsCredential(host, path, user);
        if (provider) {
          forgetForgeCredential(provider);
          set((s) => ({ forgeAuth: withSavedForgeCredentials(s.forgeAuth) }));
        }
      } catch (e) {
        useUi.getState().showToast(e, "error");
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
