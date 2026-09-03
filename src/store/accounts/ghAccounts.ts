// The accounts the `gh` CLI is logged into: loading the list, and the in-app
// sign-in / sign-out that changes it.

import { api, type GithubAccountRef, type GithubSignInResult } from "@/lib/api";
import { ACCOUNT_COLORS } from "@/lib/palette";
import { accountKey, accountRefFromApi } from "@/store/accountBindings";
import { usePulls } from "@/store/pulls";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import type { SliceSet } from "@/store/slice";

export type Forge = "GitHub" | "GitLab" | "Bitbucket" | "Azure DevOps" | "Gitea" | "Forgejo";

export interface Account {
  id: string;
  forge: Forge;
  provider: GithubAccountRef["provider"];
  host: string;
  accountId: string;
  login: string;
  label: string;
  username: string;
  name: string;
  email: string;
  color: string;
  ref: GithubAccountRef;
  /** True for the account the `gh` CLI currently treats as active. */
  active: boolean;
  /** False when `gh auth status` reported the account's credentials as broken
   * (revoked/expired token, or the check timed out) — shown as "needs re-auth". */
  healthy: boolean;
  /** Failure detail when `healthy` is false; empty otherwise. */
  healthError: string;
}

export interface GhAccountsSlice {
  accounts: Account[];
  accountsLoading: boolean;
  accountsError: string | null;
  /** The `gh` active account — the default identity for unbound repos. */
  activeAccountId: string | null;

  /** Load the accounts the `gh` CLI is logged into. */
  loadAccounts: () => Promise<void>;
  /** Start the in-app `gh auth login --web` device flow for `host` (GL-106),
   * resolving with the newly added account once authorized. Emits
   * `github-signin-progress` events; the dialog subscribes to them. */
  signInGithub: (host: string) => Promise<GithubSignInResult>;
  /** Cancel an in-flight [`signInGithub`] (kills the gh child). Idempotent. */
  cancelGithubSignIn: () => Promise<void>;
  /** Sign `account` out of `gh` (removes its credential-store entry) and
   * refresh the account list. Remotes whose URL still carries the login fall
   * back to the system credential lookup. */
  signOutGithub: (account: Account) => Promise<void>;
}

/** What `loadAccounts` needs from the rest of the store once the list lands. */
type GhAccountsHost = GhAccountsSlice & { syncRepoAccount: (path: string) => void };

// Monotonic gh-account load generation (GL-169, mirroring forgeAuthGen). App
// bootstrap and the Accounts panel refresh can overlap; only the newest
// loadAccounts may publish the list, its error, or clear the loading flag, so
// an older snapshot landing late can't restore signed-out metadata and its
// late failure can't replace a newer success.
let accountsLoadGen = 0;

export function createGhAccountsSlice(
  set: SliceSet<GhAccountsSlice>,
  get: () => GhAccountsHost,
): GhAccountsSlice {
  return {
    accounts: [],
    accountsLoading: false,
    accountsError: null,
    activeAccountId: null,

    signInGithub: (host) => api.githubSignIn(host),
    cancelGithubSignIn: () => api.cancelGithubSignIn(),

    signOutGithub: async (account) => {
      try {
        await api.githubSignOut(account.host, account.login);
      } catch (e) {
        useUi.getState().showToast(e, "error");
        return;
      }
      await get().loadAccounts();
    },

    loadAccounts: async () => {
      const gen = ++accountsLoadGen;
      set({ accountsLoading: true, accountsError: null });
      try {
        const list = await api.githubAccounts();
        if (gen !== accountsLoadGen) return; // superseded by a newer load
        const accounts: Account[] = list.map((a, i) => {
          const ref = accountRefFromApi(a);
          return {
            id: accountKey(ref),
            forge: "GitHub",
            provider: ref.provider,
            host: ref.host,
            accountId: ref.accountId,
            login: ref.login,
            label: a.email || `${ref.login}@${ref.host}`,
            username: a.username || ref.login,
            name: a.name || ref.login,
            email: a.email,
            color: ACCOUNT_COLORS[i % ACCOUNT_COLORS.length],
            ref,
            active: a.active,
            healthy: a.healthy,
            healthError: a.healthError,
          };
        });
        const activeAccountId = accounts.find((a) => a.active)?.id ?? accounts[0]?.id ?? null;
        set({ accounts, activeAccountId, accountsLoading: false });
        const path = useRepo.getState().summary?.path;
        if (path) {
          get().syncRepoAccount(path);
          // Accounts may arrive before remotes. The repo-open flow performs a
          // quiet PR load after remotes resolve; only refetch here when the
          // remote-derived account context is already present.
          if (useRepo.getState().remotes.length > 0) void usePulls.getState().loadPullRequests();
        }
      } catch (e) {
        if (gen !== accountsLoadGen) return; // a stale failure never clobbers a newer result
        set({ accountsLoading: false, accountsError: String(e) });
      }
    },
  };
}
