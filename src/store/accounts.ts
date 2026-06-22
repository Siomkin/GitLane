// Account + commit-identity state for the open repo. Split out of `ui.ts` (the
// view-chrome store) because it owns a distinct subsystem: the provider-aware
// GitHub account list, the per-repo account binding that drives PR/push/fetch
// auth, and the commit identity that is mirrored into the repo's local git
// config. The repo path is resolved lazily via `useRepo` — exactly the
// cross-store pattern `pulls.ts` already uses. Server-side token resolution is
// unchanged: commands receive account metadata, never a token.

import { create } from "zustand";

import { api, type ForgeAuthStatus, type GithubAccountRef, type RepoIdentity } from "../lib/api";
import { ACCOUNT_COLORS } from "../lib/palette";
import { useRepo } from "./repo";
import { useUi } from "./ui";
import { usePulls } from "./pulls";

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
}

// `RepoIdentity` is defined alongside the IPC layer (it's the shape
// `repo_identity` returns); re-export it so account/identity consumers keep a
// single import site.
export type { RepoIdentity };

interface RepoAccountBinding extends GithubAccountRef {
  version: 2;
}

type StoredRepoAccountBinding = RepoAccountBinding | string;

// Per-repo account binding: { [repoPath]: RepoAccountBinding } drives PR/push auth.
// Legacy string values are migrated only after they resolve against loaded accounts.
// The commit identity (name + email) is stored separately so it can be edited
// independently of the auth account (e.g. a private gh email vs. a public one).
const LS_REPO_ACCOUNTS = "gitlane.repoAccounts";
const LS_REPO_IDENTITY = "gitlane.repoIdentity";

function readJsonMap<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, T>) : {};
  } catch {
    return {};
  }
}

function writeJsonMap<T>(key: string, map: Record<string, T>) {
  try {
    localStorage.setItem(key, JSON.stringify(map));
  } catch {
    /* ignore quota / unavailable */
  }
}

const readBindings = () => readJsonMap<StoredRepoAccountBinding>(LS_REPO_ACCOUNTS);
const writeBindings = (map: Record<string, StoredRepoAccountBinding>) =>
  writeJsonMap(LS_REPO_ACCOUNTS, map);
const readIdentities = () => readJsonMap<RepoIdentity>(LS_REPO_IDENTITY);
const writeIdentities = (map: Record<string, RepoIdentity>) =>
  writeJsonMap(LS_REPO_IDENTITY, map);

function accountKey(ref: GithubAccountRef): string {
  return `${ref.provider}:${ref.host}:${ref.accountId}`;
}

function accountRefFromApi(a: {
  provider?: GithubAccountRef["provider"];
  host?: string;
  accountId?: string;
  login?: string;
  username: string;
}): GithubAccountRef {
  return {
    provider: a.provider ?? "gh",
    host: a.host ?? "github.com",
    accountId: a.accountId || a.login || a.username,
    login: a.login || a.username,
  };
}

function bindingFromAccount(account: Account): RepoAccountBinding {
  return { version: 2, ...account.ref };
}

function accountMatchesLegacy(account: Account, legacy: string): boolean {
  return (
    account.id === legacy ||
    account.username === legacy ||
    account.login === legacy ||
    account.accountId === legacy
  );
}

interface AccountsState {
  accounts: Account[];
  accountsLoading: boolean;
  accountsError: string | null;
  forgeAuth: ForgeAuthStatus[];
  forgeAuthLoading: boolean;
  forgeAuthError: string | null;
  /** The `gh` active account — the default identity for unbound repos. */
  activeAccountId: string | null;
  /** The account bound to the currently open repo (its id/username). */
  repoAccountId: string | null;
  /** Provider/account metadata sent to Rust for GitHub operations. */
  repoAccountRef: GithubAccountRef | null;
  /** Commit identity (name + email) pinned for the open repo, or null to defer
   * to git config. Editable, persisted per repo, stamped on every commit. */
  repoIdentity: RepoIdentity | null;

  /** Load the accounts the `gh` CLI is logged into. */
  loadAccounts: () => Promise<void>;
  /** Load auth-only status for non-GitHub forge providers. Skips a re-probe if
   * already loaded/loading unless `force` is set (the explicit Refresh button). */
  loadForgeAuth: (force?: boolean) => Promise<void>;
  /** Resolve the bound account + commit identity for a repo path. Sets the
   * cached identity synchronously, then reconciles from git config. */
  syncRepoAccount: (path: string) => void;
  /** Reconcile `repoIdentity` from the repo's local git config (the durable
   * source of truth), falling back to the localStorage cache. */
  hydrateRepoIdentity: (path: string) => Promise<void>;
  /** Bind the open repo to an account: persist, prefill + write identity, reload PRs. */
  setRepoAccount: (id: string | null) => Promise<void>;
  /** Edit the open repo's commit identity (name/email); persist + write to git config. */
  editRepoIdentity: (name: string, email: string) => Promise<boolean>;
}

export const useAccounts = create<AccountsState>((set, get) => ({
  accounts: [],
  accountsLoading: false,
  accountsError: null,
  forgeAuth: [],
  forgeAuthLoading: false,
  forgeAuthError: null,
  activeAccountId: null,
  repoAccountId: null,
  repoAccountRef: null,
  repoIdentity: null,

  loadAccounts: async () => {
    set({ accountsLoading: true, accountsError: null });
    try {
      const list = await api.githubAccounts();
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
        };
      });
      const activeAccountId = accounts.find((a) => a.active)?.id ?? accounts[0]?.id ?? null;
      set({ accounts, activeAccountId, accountsLoading: false });
      const path = useRepo.getState().summary?.path;
      if (path) {
        get().syncRepoAccount(path);
        // Accounts may have arrived after the repo loaded — refetch PRs so they
        // reflect the now-resolved bound account.
        void usePulls.getState().loadPullRequests();
      }
    } catch (e) {
      set({ accountsLoading: false, accountsError: String(e) });
    }
  },

  loadForgeAuth: async (force = false) => {
    const { forgeAuthLoading, forgeAuth } = get();
    if (forgeAuthLoading) return;
    if (!force && forgeAuth.length > 0) return;
    set({ forgeAuthLoading: true, forgeAuthError: null });
    try {
      const next = await api.forgeAuthStatuses();
      set({ forgeAuth: next, forgeAuthLoading: false });
    } catch (e) {
      set({ forgeAuthLoading: false, forgeAuthError: String(e) });
    }
  },

  syncRepoAccount: (path) => {
    const bindings = readBindings();
    const bound = bindings[path];
    let selected: Account | null = null;
    if (typeof bound === "string") {
      selected = get().accounts.find((a) => accountMatchesLegacy(a, bound)) ?? null;
      if (selected) {
        bindings[path] = bindingFromAccount(selected);
        writeBindings(bindings);
      }
    } else if (bound && bound.version === 2) {
      const key = accountKey(bound);
      selected = get().accounts.find((a) => a.id === key) ?? null;
    } else if (!bound) {
      selected = get().accounts.find((a) => a.id === get().activeAccountId) ?? null;
    }
    set({
      repoAccountId: selected?.id ?? null,
      repoAccountRef: selected?.ref ?? null,
      // Optimistic: show the cached identity immediately (avoids a flash),
      // then reconcile against git config — the build-independent truth.
      repoIdentity: readIdentities()[path] ?? null,
    });
    void get().hydrateRepoIdentity(path);
  },

  hydrateRepoIdentity: async (path) => {
    let identity: RepoIdentity | null;
    try {
      identity = await api.repoIdentity(path);
    } catch {
      return; // keep the optimistic localStorage value on read failure
    }
    // Ignore a stale resolution if the user switched repos meanwhile.
    if (useRepo.getState().summary?.path !== path) return;
    if (identity) {
      // git config wins; refresh the cache so both agree.
      set({ repoIdentity: identity });
      const identities = readIdentities();
      identities[path] = identity;
      writeIdentities(identities);
    } else {
      // Nothing pinned in git config → defer to global config. Drop any stale
      // cache so a removed identity doesn't resurrect on the next open.
      set({ repoIdentity: null });
      const identities = readIdentities();
      if (identities[path]) {
        delete identities[path];
        writeIdentities(identities);
      }
    }
  },

  setRepoAccount: async (id) => {
    const account = get().accounts.find((a) => a.id === id) ?? null;
    set({ repoAccountId: account?.id ?? null, repoAccountRef: account?.ref ?? null });
    const path = useRepo.getState().summary?.path ?? null;
    if (path) {
      const bindings = readBindings();
      if (account) bindings[path] = bindingFromAccount(account);
      else delete bindings[path];
      writeBindings(bindings);
    }
    if (path && account) {
      // Picking an account prefills the commit identity from it; the user can
      // then edit the email (e.g. a public address) in the Identity tab.
      const ok = await get().editRepoIdentity(account.name, account.email);
      if (ok) useUi.getState().showToast(`This repo will commit & fetch as @${account.username}`);
    } else if (path) {
      // "No identity" — drop the pinned identity and defer to global git
      // config. Clear both the cache and the local git config so the choice is
      // durable and won't be re-hydrated from a stale value on the next open.
      const identities = readIdentities();
      delete identities[path];
      writeIdentities(identities);
      set({ repoIdentity: null });
      try {
        await api.clearRepoIdentity(path);
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
      useUi.getState().showToast("Identity cleared");
    }
    void usePulls.getState().loadPullRequests();
  },

  editRepoIdentity: async (name, email) => {
    const path = useRepo.getState().summary?.path ?? null;
    const identity: RepoIdentity = { name: name.trim(), email: email.trim() };
    set({ repoIdentity: identity });
    if (!path) return true;
    const identities = readIdentities();
    identities[path] = identity;
    writeIdentities(identities);
    try {
      // Mirror to the repo's local git config so CLI / other tools agree.
      await api.setRepoIdentity(path, identity.name, identity.email);
      return true;
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
      return false;
    }
  },
}));
