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

/** Fields every mode carries. */
interface TransportAuthBase {
  /** Display/classification host, without port. */
  host: string;
  /** Exact credential authority (`host[:port]`) Git passes to helpers. */
  credentialHost: string;
}

/** Provider-neutral git transport auth for clone/fetch/pull/push, one member
 * per `mode` — mirrors the Rust `GitTransportAuthRef` enum field for field, so
 * a ref missing its mode's required field fails to compile instead of failing
 * serde at IPC time. Never carries tokens; HTTPS identities are URL usernames
 * resolved by git credential helpers, except `providerToken` mode, where the
 * backend fetches a GitLane-owned token from the OS keychain via GIT_ASKPASS
 * (GL-132) using `providerAccountId` — a non-secret keychain locator. */
export type GitTransportAuthRef =
  /** The user's own credential helper / GCM; nothing injected. */
  | (TransportAuthBase & { mode: "system" })
  /** SSH remotes authenticate by key; nothing injected. */
  | (TransportAuthBase & { mode: "ssh" })
  /** GitHub `gh` credential helper; the account ref still carries no token. */
  | (TransportAuthBase & {
      mode: "githubGh";
      /** HTTPS URL username, if one is selected. */
      username?: string | null;
      accountRef: GithubAccountRef;
    })
  /** GitLab `glab` credential helper (GL-139). */
  | (TransportAuthBase & {
      mode: "gitlabGlab";
      username?: string | null;
      provider: GitTransportProvider;
    })
  /** The user's configured credential helper. */
  | (TransportAuthBase & {
      mode: "credentialHelper";
      username?: string | null;
      /** Match Git's credential.useHttpPath lookup for path-scoped credentials. */
      useHttpPath?: boolean;
    })
  /** A GitLane-owned keychain token fed through the GIT_ASKPASS bridge. */
  | (TransportAuthBase & {
      mode: "providerToken";
      username: string;
      provider: GitTransportProvider;
      /** Keychain locator; never a token. */
      providerAccountId: string;
    });

/** The `gitlabGlab` member, which the clone flow and the store both build. */
export type GitlabGlabAuthRef = Extract<GitTransportAuthRef, { mode: "gitlabGlab" }>;

/** One `remote → auth` pair for the multi-remote fetch. */
export interface RemoteAccountRef {
  remote: string;
  auth: GitTransportAuthRef;
}
