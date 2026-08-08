// Git transport auth refs (never tokens) — mirrors
// `src-tauri/src/git/types/auth.rs`.

import type { GithubAccountRef } from "@/lib/api/github";

export type GitTransportAuthMode =
  | "system"
  | "ssh"
  | "githubGh"
  | "gitlabGlab"
  | "credentialHelper"
  | "providerToken";
export type GitTransportProvider =
  | "github"
  | "gitlab"
  | "bitbucket"
  | "azure-devops"
  | "gitea"
  | "forgejo"
  | "other";

/** Provider-neutral git transport auth for clone/fetch/pull/push. Never carries
 * tokens; HTTPS identities are URL usernames resolved by git credential helpers,
 * except `providerToken` mode, where the backend fetches a GitLane-owned token
 * from the OS keychain via GIT_ASKPASS (GL-132) using `providerAccountId` — a
 * non-secret keychain locator — rather than any token on this ref. */
export interface GitTransportAuthRef {
  mode: GitTransportAuthMode;
  provider?: GitTransportProvider;
  /** Display/classification host, without port. */
  host: string;
  /** Exact credential authority (`host[:port]`) Git passes to helpers. */
  credentialHost: string;
  /** HTTPS URL username, if one is selected. */
  username?: string | null;
  /** GitHub account metadata for `githubGh`; still no token. */
  accountRef?: GithubAccountRef | null;
  /** Keychain locator for `providerToken` mode; never a token. */
  providerAccountId?: string | null;
  /** Match Git's credential.useHttpPath lookup for path-scoped credentials. */
  useHttpPath?: boolean;
}

/** One `remote → auth` pair for the multi-remote fetch. */
export interface RemoteAccountRef {
  remote: string;
  auth: GitTransportAuthRef;
}
