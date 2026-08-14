// Native provider OAuth sign-in (GL-139): GitLab's device flow and Bitbucket's
// PKCE loopback, plus the per-host public client id they resolve against. The
// backend runs the flow and writes the token to the OS keychain — this slice
// only records the non-secret metadata, pins the OAuth transport username into
// the target remote, and owns the compensation a *late* cancel needs.

import {
  api,
  type ForgeAuthProvider,
  type OauthClientStatus,
  type ProviderOauthResult,
} from "@/lib/api";
import { captureRepoMutationTarget } from "@/store/accounts/repoMutation";
import {
  providerTokenKey,
  writeProviderTokens,
  type StoredProviderToken,
} from "@/store/accountsStorage";
import type { CredentialsSlice } from "@/store/accounts/credentials";
import { useRepo } from "@/store/repo";
import type { SliceSet } from "@/store/slice";
import { useUi } from "@/store/ui";

export interface OauthSlice {
  /** Native OAuth sign-in for a non-GitHub provider (GL-139): GitLab's device
   * flow or Bitbucket's PKCE loopback. Records the resulting keychain-token
   * account (the token itself is stored in Rust) and, when `remote` is given,
   * pins the OAuth transport username into that remote's URL so it immediately
   * authenticates via `providerToken`. Emits `provider-oauth-progress` events. */
  signInProviderOauth: (
    provider: ForgeAuthProvider,
    host: string,
    remote?: string,
  ) => Promise<ProviderOauthResult>;
  /** Cancel an in-flight [`signInProviderOauth`], discarding any codes. */
  cancelProviderOauthSignIn: () => Promise<void>;
  /** Fully undo a completed OAuth sign-in after a *late* cancel (GL-139) — one
   * that finished (token stored, remote pinned) before the cancel registered.
   * `result` is the exact object returned by [`signInProviderOauth`] and serves
   * as the run-ownership handle; a copied/lookalike result is intentionally a
   * no-op so it cannot resolve a later retry through the shared sentinel key.
   * Restores `remote`'s prior URL username (`priorUsername`, snapshotted before
   * the pin via [`remoteUrlUsername`]) so the pin is reverted rather than left
   * dangling, then deletes the keychain token + metadata. If restoring the
   * remote fails, the usable token/account is retained rather than leaving a
   * sentinel username pointing at a deleted credential. */
  rollbackProviderOauthSignIn: (
    provider: ForgeAuthProvider,
    result: ProviderOauthResult,
    remote: string | undefined,
    priorUsername: string | null,
  ) => Promise<void>;
  /** Whether native OAuth is configured for a provider/host (GL-139) — a client
   * id resolves. Drives whether the OAuth sign-in path is offered vs the PAT
   * fallback. Read-through to the backend; never returns the client id. */
  oauthClientStatus: (provider: ForgeAuthProvider, host: string) => Promise<OauthClientStatus>;
  /** Set (or clear, when empty) the per-host public OAuth client id (GL-139). */
  setOauthClientId: (
    provider: ForgeAuthProvider,
    host: string,
    clientId: string,
  ) => Promise<void>;
}

interface OauthRemotePin {
  path: string;
  remote: string;
  provider: string;
  accountId: string;
}

interface OauthRunEffects {
  tokenKey: string;
  tokenEntry: StoredProviderToken;
  pin: OauthRemotePin | null;
}

/** Exact side effects owned by each completed OAuth result. The result object is
 * the run's opaque frontend handle: a late-cancel rollback may remove metadata
 * or a remote pin only while those exact objects are still current. A retry that
 * replaces the shared sentinel key/pin therefore cannot be consumed by the old
 * run's compensation. */
const oauthRunEffects = new WeakMap<ProviderOauthResult, OauthRunEffects>();
let lastOauthRemotePin: OauthRemotePin | null = null;

/** OAuth records the keychain-token metadata the credentials slice owns. */
type OauthSet = SliceSet<OauthSlice & Pick<CredentialsSlice, "providerTokens">>;

export function createOauthSlice(
  set: OauthSet,
  get: () => Pick<CredentialsSlice, "providerTokens">,
): OauthSlice {
  return {
    signInProviderOauth: async (provider, host, remote) => {
      // Capture the repo the pin will target BEFORE the user-length browser flow
      // (GL-167): the user may switch repos while authorizing, and the pin must
      // land on the repo whose picker started this sign-in — never on whichever
      // repo happens to be open when the flow returns.
      const target = remote ? captureRepoMutationTarget(remote) : null;
      // A new sign-in invalidates any previous flow's pin record — only a pin
      // THIS flow writes may be rolled back by its own late cancel.
      lastOauthRemotePin = null;
      // The backend runs the flow and writes the token to the OS keychain; only
      // non-secret metadata comes back. We record *that* an account exists so the
      // transport layer can select `providerToken` and the UI can show sign-out.
      const result = await api.providerOauthSignIn(provider, host);
      const credentialHost = result.host;
      // An OAuth token authenticates git as a sentinel username, not the human
      // handle — key by (and pin) that, but display the real login.
      const entry: StoredProviderToken = {
        provider,
        credentialHost,
        accountId: result.accountId,
        login: result.login,
        transportUsername: result.transportUsername,
        savedAt: Date.now(),
      };
      const key = providerTokenKey(credentialHost, result.transportUsername);
      // OAuth metadata keys on the sentinel transport username (same for every
      // account on a host), but the keychain token keys on the account id. Signing
      // in as a *different* account on the same host would overwrite this metadata
      // and orphan the previous keychain token — invisible and unreachable by
      // reconcile. Delete the superseded token first (best-effort).
      const existing = get().providerTokens[key];
      if (existing && existing.accountId !== result.accountId) {
        try {
          await api.deleteProviderToken(existing.provider, existing.credentialHost, existing.accountId);
        } catch {
          // Transactional replacement: if the old token can't be removed, roll the
          // new sign-in back — delete the token the backend just wrote and keep the
          // previous account intact — rather than overwrite its metadata and orphan
          // the old secret (unreachable by reconcile). The old account stays usable.
          try {
            await api.deleteProviderToken(provider, credentialHost, result.accountId);
          } catch {
            /* both keychain deletes failed — leave the old account signed in */
          }
          throw new Error(
            `Couldn't replace the ${existing.credentialHost} account — its previous token is still in the keychain, so the old account is still signed in. Try again.`,
          );
        }
      }
      const next = { ...get().providerTokens, [key]: entry };
      writeProviderTokens(next);
      set({ providerTokens: next });
      const effects: OauthRunEffects = { tokenKey: key, tokenEntry: entry, pin: null };
      oauthRunEffects.set(result, effects);
      if (remote && target && target.path) {
        // Pin the OAuth transport username into the remote's URL — the git-native
        // account selector — so fetch/push immediately resolve `providerToken`.
        // Written to the CAPTURED repo, and remembered so a late-cancel rollback
        // un-pins the same repo (GL-167).
        await api.setRemoteUsername(target.path, remote, result.transportUsername);
        const pin = { path: target.path, remote, provider, accountId: result.accountId };
        effects.pin = pin;
        lastOauthRemotePin = pin;
        if (target.isCurrent()) await useRepo.getState().listRemotes();
      }
      return result;
    },
    cancelProviderOauthSignIn: () => api.cancelProviderOauthSignIn(),
    rollbackProviderOauthSignIn: async (provider, result, remote, priorUsername) => {
      const effects = oauthRunEffects.get(result);
      if (!effects || effects.tokenEntry.provider !== provider) return;
      // Un-pin first: restore the account the remote carried before the sign-in
      // pinned this token's sentinel — not just strip it, since the remote may have
      // named a different account. If this durable write fails, keep the token:
      // deleting it would strand the remote on an OAuth sentinel with no matching
      // credential. The visible account remains manageable and rollback can retry.
      if (remote) {
        // Target the repo the sign-in actually pinned (GL-167) — the user may be
        // in another repo by now. The pin must match this rollback's exact
        // sign-in (remote + provider + account); no match means that sign-in
        // never pinned (no repo was open), so there is nothing to un-pin.
        const pin = effects.pin;
        const path = pin && lastOauthRemotePin === pin && pin.remote === remote ? pin.path : null;
        if (path) {
          try {
            await api.setRemoteUsername(path, remote, priorUsername);
          } catch (e) {
            useUi.getState().showToast(
              `Could not restore the remote account; the OAuth credential was kept. ${String(e)}`,
              "error",
            );
            return;
          }
          // A newer sign-in may have installed its own pin while the git write
          // was pending. Never clear that newer owner's rollback handle.
          if (lastOauthRemotePin === pin) lastOauthRemotePin = null;
          if ((useRepo.getState().summary?.path ?? "") === path) {
            try {
              await useRepo.getState().listRemotes();
            } catch {
              /* durable restore succeeded; the next repo refresh will reconcile */
            }
          }
        }
      }
      // Delete only the token metadata object this run installed. OAuth accounts
      // share a sentinel map key, so resolving the key again here could select a
      // later retry's entry and delete that retry's keychain token instead.
      if (get().providerTokens[effects.tokenKey] !== effects.tokenEntry) return;
      try {
        await api.deleteProviderToken(
          effects.tokenEntry.provider,
          effects.tokenEntry.credentialHost,
          effects.tokenEntry.accountId,
        );
        // Compare again after the keychain await: a later writer's metadata must
        // remain visible/manageable even if it replaced this key mid-delete.
        if (get().providerTokens[effects.tokenKey] !== effects.tokenEntry) return;
        const next = { ...get().providerTokens };
        delete next[effects.tokenKey];
        writeProviderTokens(next);
        set({ providerTokens: next });
        oauthRunEffects.delete(result);
      } catch (e) {
        // Keep the exact metadata entry manageable when keychain cleanup fails.
        useUi.getState().showToast(String(e), "error");
      }
    },
    oauthClientStatus: (provider, host) => api.oauthClientStatus(provider, host),
    setOauthClientId: async (provider, host, clientId) => {
      await api.setOauthClientId(provider, host, clientId);
    },
  };
}
