// Auth-only status for the non-GitHub forge CLIs (glab, and the saved-credential
// providers that have none), plus the background whoami that resolves each
// connected provider's real account. GitHub accounts come from `gh` and live in
// `ghAccounts.ts`; this slice is what the connected-forge cards render.

import { api, type ForgeAuthStatus } from "@/lib/api";
import { supportsForgeWhoami } from "@/lib/forgeHelp";
import type { CredentialsSlice } from "@/store/accounts/credentials";
import { withSavedForgeCredentials } from "@/store/forgeCredentials";
import type { SliceSet } from "@/store/slice";
import { refreshToolProbes } from "@/store/toolProbes";
import { useUi } from "@/store/ui";

export interface ForgeAuthSlice {
  forgeAuth: ForgeAuthStatus[];
  forgeAuthLoading: boolean;
  forgeAuthError: string | null;
  /** Providers whose real account identity is still being resolved (whoami in
   * flight) — the connected forge card shows an identity skeleton meanwhile. */
  forgeAccountsLoading: string[];

  /** Load auth-only status for non-GitHub forge providers. Skips a re-probe if
   * already loaded/loading unless `force` is set (the explicit Refresh button). */
  loadForgeAuth: (force?: boolean) => Promise<void>;
  /** Sign out of a non-GitHub provider CLI when GitLane knows a safe logout command. */
  signOutForge: (provider: ForgeAuthStatus["provider"]) => Promise<void>;
}

// Providers GitLane can resolve a real account for. Keep in sync with the
// `account()` whoami dispatch in `src-tauri/src/auth_providers.rs` — adding a
// provider there without listing it here means its identity never resolves in
// the UI. Others (Gitea/Forgejo) would only make a no-op round-trip + skeleton flash.
// Monotonic load generation. A background whoami started by an older
// loadForgeAuth is dropped (not merged) once a newer load supersedes it, so a
// stale identity can't land on a refreshed / signed-out provider row.
let forgeAuthGen = 0;

export function createForgeAuthSlice(
  set: SliceSet<ForgeAuthSlice>,
  get: () => ForgeAuthSlice & Pick<CredentialsSlice, "reconcileProviderTokens">,
): ForgeAuthSlice {
  return {
    forgeAuth: [],
    forgeAuthLoading: false,
    forgeAuthError: null,
    forgeAccountsLoading: [],

    signOutForge: async (provider) => {
      await refreshToolProbes();
      try {
        await api.forgeSignOut(provider);
      } catch (e) {
        useUi.getState().showToast(e, "error");
        return;
      }
      await get().loadForgeAuth(true);
    },

    loadForgeAuth: async (force = false) => {
      const { forgeAuthLoading, forgeAuth } = get();
      // A non-forced call defers to an in-flight load or an already-loaded list.
      // A forced refresh supersedes an in-flight probe (the generation counter
      // drops the older probe's result) so a rapid double-Refresh stays responsive.
      if (!force && forgeAuthLoading) return;
      if (!force && forgeAuth.length > 0) return;
      const gen = ++forgeAuthGen;
      set({ forgeAuthLoading: true, forgeAuthError: null });
      // The explicit Refresh is the Accounts panel's retry: re-probe the CLIs
      // so a glab installed since the last probe shows as available.
      if (force) await refreshToolProbes();
      try {
        const next = withSavedForgeCredentials(await api.forgeAuthStatuses());
        if (gen !== forgeAuthGen) return; // superseded by a newer load
        // Show the authenticated forges immediately; their real identity resolves
        // in the background (a per-provider network whoami) so the card can render
        // now with an identity skeleton instead of blocking on the slow call. Only
        // providers with a whoami implementation are marked pending.
        const pending = next
          .filter((f) => f.authenticated === true && supportsForgeWhoami(f.provider))
          .map((f) => f.provider);
        set({ forgeAuth: next, forgeAuthLoading: false, forgeAccountsLoading: pending });
        // Drop any keychain-token metadata whose secret vanished outside GitLane,
        // so a "signed in" row can't linger while transport silently fails.
        void get().reconcileProviderTokens();
        for (const provider of pending) {
          const done = () =>
            set((s) => ({ forgeAccountsLoading: s.forgeAccountsLoading.filter((p) => p !== provider) }));
          void api
            .forgeAccount(provider)
            .then((account) => {
              if (gen !== forgeAuthGen) return; // a newer refresh replaced this snapshot
              set((s) => ({
                // Only merge onto a row that is still this provider AND still
                // authenticated — a refresh may have signed it out meanwhile.
                forgeAuth: account
                  ? s.forgeAuth.map((f) =>
                      f.provider === provider && f.authenticated ? { ...f, account } : f,
                    )
                  : s.forgeAuth,
                forgeAccountsLoading: s.forgeAccountsLoading.filter((p) => p !== provider),
              }));
            })
            .catch(() => {
              if (gen === forgeAuthGen) done();
            });
        }
      } catch (e) {
        if (gen !== forgeAuthGen) return;
        set({ forgeAuthLoading: false, forgeAuthError: String(e), forgeAccountsLoading: [] });
      }
    },
  };
}
