// How an account is *resolved* for a git operation or the PR surface — pure
// reads over the account list, the keychain-token metadata and the forge-auth
// probe. Nothing here writes: every function answers "which credential
// authenticates this remote / this repo's PRs", git-natively (the HTTPS URL
// username is the account selector) and without ever carrying token material.

import {
  ForgeKind,
  type ForgeAuthStatus,
  type GitTransportAuthRef,
  type GithubAccountRef,
} from "@/lib/api";
import {
  detectRemoteUrl,
  forgeAuthProviderFor,
  transportProviderForRemoteProvider,
} from "@/lib/remotes";
import { accountMatchesRemoteHost } from "@/store/accountBindings";
import type { Account } from "@/store/accounts/ghAccounts";
import {
  pickProviderTokenForHost,
  providerTokenKey,
  readForgeCredentials,
  type StoredProviderToken,
} from "@/store/accountsStorage";
import { useRepo } from "@/store/repo";

export type GitTransportDirection = "fetch" | "push";


/** Host + credential authority for the open repo's default **GitLab** remote, or
 * null when the repo isn't GitLab or no host can be resolved. Shared by
 * `gitlabPr()` and `prAccountRef()` so the GitLab PR-account host resolution
 * lives in one place (GL-145). */
function gitlabRemoteHosts(): { host: string; credentialHost: string } | null {
  const forge = useRepo.getState().forge;
  if (!forge || forge.kind !== ForgeKind.GitLab) return null;
  const remotes = useRepo.getState().remotes ?? [];
  const defaultRemote = remotes.find((r) => r.isDefault) ?? remotes[0] ?? null;
  const info = defaultRemote ? detectRemoteUrl(defaultRemote.pushUrl || defaultRemote.fetchUrl) : null;
  const host = info?.host ?? forge.host ?? null;
  const credentialHost = info?.credentialHost ?? host;
  return host && credentialHost ? { host, credentialHost } : null;
}

/** Host + credential authority for the open repo's default **Bitbucket** remote,
 * or null when the repo isn't Bitbucket or no host can be resolved. Shared by
 * `bitbucketPr()` and `prAccountRef()` so the Bitbucket PR-account host
 * resolution lives in one place (GL-141), mirroring {@link gitlabRemoteHosts}. */
function bitbucketRemoteHosts(): { host: string; credentialHost: string } | null {
  const forge = useRepo.getState().forge;
  if (!forge || forge.kind !== ForgeKind.Bitbucket) return null;
  const remotes = useRepo.getState().remotes ?? [];
  const defaultRemote = remotes.find((r) => r.isDefault) ?? remotes[0] ?? null;
  const info = defaultRemote ? detectRemoteUrl(defaultRemote.pushUrl || defaultRemote.fetchUrl) : null;
  const host = info?.host ?? forge.host ?? null;
  const credentialHost = info?.credentialHost ?? host;
  return host && credentialHost ? { host, credentialHost } : null;
}

export interface TransportAuthSlice {
  /** PR-auth readiness + display label for the open repo's default **GitLab**
   * remote (GL-145): `ready` is true when glab is signed in for the host or a
   * GitLane-owned keychain token exists; `label` is the account handle to show
   * (`@login`, or `glab`), else null. `{ ready: false, label: null }` for a
   * non-GitLab repo. Shared by the toolbar provider popover (connected vs
   * needs-auth) and the remotes-settings card. Never carries token material. */
  gitlabPr: () => { ready: boolean; label: string | null };
  /** Whether Bitbucket pull requests can be fetched for the open repo — a stored
   * Bitbucket token (OAuth or API token) exists for the host — plus its display
   * label. Bitbucket has no CLI, so a token is the only path (GL-141). */
  bitbucketPr: () => { ready: boolean; label: string | null };
  /** The account ref the PR surface passes for the open repo. For a GitHub repo
   * it's the gh-derived `repoAccountRef`. For a GitLab repo (GL-140) it prefers
   * glab's zero-config transport — returning `null` so the backend uses glab —
   * else a GitLab keychain-token account (OAuth from GL-139 or a PAT from GL-132)
   * so the backend's REST client can resolve the token by its non-secret locator;
   * `null` when neither is available (the backend then reports how to sign in).
   * Never carries token material. */
  prAccountRef: () => GithubAccountRef | null;
  /** The account ref that authenticates `remote`, or null for system git
   * credentials. What write actions send to push/fetch commands (GL-129). */
  accountRefForRemote: (remote: string) => GithubAccountRef | null;
  /** Provider-neutral git transport auth for the URL `remote` uses in
   * `direction`, or null for system git credentials / SSH without inline helper
   * injection. Push is the default for existing push-family callers. */
  transportAuthForRemote: (
    remote: string,
    direction?: GitTransportDirection,
  ) => GitTransportAuthRef | null;
  /** The `gitlabGlab` transport ref for a GitLab host, or null when glab can't
   * serve it (not GitLab, glab not installed/authed, or an HTTPS credential is
   * saved for GitLab). Shared by `transportAuthForRemote` and the clone flow so
   * both wire glab identically (GL-139). */
  gitlabGlabAuth: (
    host: string,
    credentialHost: string,
    provider: GitTransportAuthRef["provider"],
  ) => GitTransportAuthRef | null;
}

/** What resolution reads from the rest of the store. */
type TransportAuthHost = TransportAuthSlice & {
  accounts: Account[];
  forgeAuth: ForgeAuthStatus[];
  providerTokens: Record<string, StoredProviderToken>;
  repoAccountRef: GithubAccountRef | null;
  repoRemoteAccountIds: Record<string, string | null>;
};

export function createTransportAuthSlice(get: () => TransportAuthHost): TransportAuthSlice {
  return {
    gitlabPr: () => {
      const hosts = gitlabRemoteHosts();
      if (!hosts) return { ready: false, label: null };
      // glab (zero-config, single account per host) — label from its whoami if known.
      if (get().gitlabGlabAuth(hosts.host, hosts.credentialHost, "gitlab")) {
        const glab = get().forgeAuth.find(
          (f) => f.provider === "gitlab" && f.cli === "glab" && f.authenticated === true,
        );
        const username = glab?.account?.username;
        return { ready: true, label: username ? `@${username}` : "glab" };
      }
      // A stored OAuth/PAT token authenticates the REST client.
      const token = pickProviderTokenForHost(get().providerTokens, hosts.credentialHost, "gitlab");
      if (token) return { ready: true, label: `@${token.login}` };
      return { ready: false, label: null };
    },

    bitbucketPr: () => {
      const hosts = bitbucketRemoteHosts();
      if (!hosts) return { ready: false, label: null };
      // Bitbucket has no first-party CLI, so readiness depends solely on a stored
      // Bitbucket token (OAuth from GL-139 or an API token) for the host (GL-141).
      const token = pickProviderTokenForHost(get().providerTokens, hosts.credentialHost, "bitbucket");
      if (token) return { ready: true, label: `@${token.login}` };
      return { ready: false, label: null };
    },

    prAccountRef: () => {
      const forge = useRepo.getState().forge;
      // GitHub — or an unknown forge still loading — uses the gh binding, which is
      // the historical behaviour (the store's PR gate treats unknown as capable).
      if (!forge || forge.kind === ForgeKind.GitHub) return get().repoAccountRef;
      // Bitbucket (GL-141): a GitLane-owned keychain token is required (no CLI
      // fallback). Pass the token's non-secret keychain locator — the `native`
      // provider tag routes to the Bitbucket provider (dispatch is by the repo's
      // forge, not this field); the token itself never leaves Rust.
      if (forge.kind === ForgeKind.Bitbucket) {
        const hosts = bitbucketRemoteHosts();
        if (!hosts) return null;
        const token = pickProviderTokenForHost(get().providerTokens, hosts.credentialHost, "bitbucket");
        // `login` carries the git HTTPS *username* the backend authenticates as,
        // which picks the REST auth scheme: an OAuth token's `x-token-auth` sentinel
        // → Bearer; a manually-stored API token / app password's real username →
        // Basic. The token itself never leaves Rust.
        return token
          ? {
              provider: "native",
              host: token.credentialHost,
              accountId: token.accountId,
              login: token.transportUsername ?? token.login,
            }
          : null;
      }
      // Only GitLab has a native PR provider besides GitHub/Bitbucket today.
      const hosts = gitlabRemoteHosts();
      if (!hosts) return null;
      // Prefer glab: a null ref makes the backend use glab's zero-config transport
      // (it owns its own token + host). `gitlabGlabAuth` is non-null exactly when
      // glab can serve this host, mirroring how git transport resolves for GitLab.
      if (get().gitlabGlabAuth(hosts.host, hosts.credentialHost, "gitlab")) return null;
      // Otherwise a GitLane-owned keychain token (OAuth/PAT) authenticates the
      // backend's REST client. Pass the token's non-secret keychain locator — the
      // `native` provider tag routes to the GitLab provider (dispatch is by the
      // repo's forge, not this field); the token itself never leaves Rust.
      const token = pickProviderTokenForHost(get().providerTokens, hosts.credentialHost, "gitlab");
      if (token) {
        return {
          provider: "native",
          host: token.credentialHost,
          accountId: token.accountId,
          login: token.login,
        };
      }
      return null;
    },

    accountRefForRemote: (remote) => {
      const id = get().repoRemoteAccountIds[remote];
      if (!id) return null;
      return get().accounts.find((a) => a.id === id)?.ref ?? null;
    },

    transportAuthForRemote: (remote, direction = "push") => {
      const target = useRepo.getState().remotes.find((r) => r.name === remote);
      if (!target) return null;
      // Git fetch/pull contact only remote.url. Push-family operations contact a
      // separate remote.pushurl when configured, falling back to remote.url.
      // Resolve the account from that exact URL so split-host remotes never send
      // one authority's helper/token to the other authority.
      const url = direction === "fetch" ? target.fetchUrl : target.pushUrl || target.fetchUrl;
      const info = detectRemoteUrl(url);
      if (!info.valid || info.ssh || !info.host || !info.credentialHost) return null;
      // Capture the narrowed authority so the glab closure below keeps the
      // non-null types (closures don't inherit the guard's narrowing).
      const host = info.host;
      const credentialHost = info.credentialHost;
      // Map the remote's classified provider to the transport provider tag. Azure
      // normalizes "azure" → "azure-devops"; github/gitlab/bitbucket/gitea/forgejo
      // pass through (all valid transport providers now they classify); "other"
      // stays "other".
      const provider = transportProviderForRemoteProvider(info.provider);

      const glabAuth = get().gitlabGlabAuth(host, credentialHost, provider);

      // A GitLane-owned keychain token (OAuth or PAT, GL-132/GL-139) is fed to git
      // by the backend via GIT_ASKPASS and authenticates *by host*, so it activates
      // for a bare remote URL too — no username binding needed. `transportUsername`
      // is the sentinel for OAuth (oauth2 / x-token-auth), the handle for a PAT.
      const tokenRef = (t: StoredProviderToken): GitTransportAuthRef => ({
        mode: "providerToken",
        provider: t.provider,
        host,
        credentialHost,
        username: t.transportUsername ?? t.login,
        providerAccountId: t.accountId,
      });
      const tokenForHost = pickProviderTokenForHost(get().providerTokens, credentialHost);

      // `saveHttpsCredential` records the non-secret scope that was approved.
      // A non-Azure advanced path save needs the same one-invocation
      // `credential.useHttpPath=true` override as Azure, otherwise subsequent git
      // commands omit the path and cannot retrieve that helper entry. Match the
      // exact Git-decoded path, authority, and (when the URL pins one) username so
      // one path-scoped credential never changes lookup semantics for a different
      // account or repository on the same host.
      const markerProvider = forgeAuthProviderFor(info.provider);
      const savedCredential = markerProvider ? readForgeCredentials()[markerProvider] : undefined;
      const usesSavedCredentialPath =
        savedCredential?.path != null &&
        savedCredential.path !== "" &&
        info.credentialPath === savedCredential.path &&
        savedCredential.credentialHost.trim().toLowerCase() === credentialHost.trim().toLowerCase() &&
        (!info.user || savedCredential.username.toLowerCase() === info.user.toLowerCase());
      const useHttpPath = info.provider === "azure" || usesSavedCredentialPath;
      const helperAuth = (): GitTransportAuthRef => ({
        mode: "credentialHelper",
        provider,
        host,
        credentialHost,
        username: info.user,
        ...(useHttpPath ? { useHttpPath: true } : {}),
      });

      // The HTTPS account mode selects the identity by the URL username; without
      // one, a keychain token or glab (both host-scoped) authenticate. A
      // path-scoped helper is also explicit auth: return its ref even for a bare
      // URL so Git receives the path and can let the helper supply the username.
      if (!info.user) {
        return tokenForHost ? tokenRef(tokenForHost) : (glabAuth ?? (useHttpPath ? helperAuth() : null));
      }

      const account = get().accounts.find(
        (a) => accountMatchesRemoteHost(a, info) && a.login.toLowerCase() === info.user!.toLowerCase(),
      );
      if (account) {
        return {
          mode: "githubGh",
          provider: "github",
          host,
          credentialHost,
          username: info.user,
          accountRef: account.ref,
        };
      }
      // An explicitly stored keychain token beats glab and the system helper —
      // prefer one keyed by the URL username, else any token for the host (an OAuth
      // token keyed by its sentinel username, not the human handle in the URL).
      const token = get().providerTokens[providerTokenKey(credentialHost, info.user)] ?? tokenForHost;
      if (token) return tokenRef(token);

      return glabAuth ?? helperAuth();
    },

    // GitLab: when glab is signed in, inject `glab auth git-credential` per
    // invocation — the same zero-config transport gh gives GitHub (GL-139). glab is
    // single-account and answers by host, so a URL username is optional. Gated on
    // glab CLI actually installed *and* authenticated (not a saved-credential
    // override), and skipped when an HTTPS credential is saved for GitLab — that
    // lives in the user's own helper, and glab's reset would shadow it.
    gitlabGlabAuth: (host, credentialHost, provider) => {
      if (provider !== "gitlab" || readForgeCredentials()["gitlab"] !== undefined) return null;
      const glab = get().forgeAuth.find(
        (f) => f.provider === "gitlab" && f.cli === "glab" && f.available === true && f.authenticated === true,
      );
      if (!glab) return null;
      return { mode: "gitlabGlab", provider: "gitlab", host, credentialHost, username: null };
    },
  };
}
