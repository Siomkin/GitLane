// The configured remotes and everything that talks to one: forge detection,
// remote CRUD, fetch/pull/push, publish, force-push, and the remote-side branch
// and tag deletes. Mirrors `commands/remotes.rs`.

import { invoke } from "@/lib/api/invoke";
import type {
  ForcePushRouteLease,
  GitTransportAuthRef,
  RemoteAccountRef,
  RemoteInfo,
  RepoForge,
} from "./types";

export const remotesApi = {
  /** Detect the open repo's remote forge for the toolbar provider indicator. */
  repoForge: (path: string) => invoke<RepoForge>("repo_forge", { path }),

  /** List the repo's configured remotes (Repository settings → Remotes). */
  listRemotes: (path: string) => invoke<RemoteInfo[]>("list_remotes", { path }),

  /** Add a new remote `name` → `url` (`git remote add`). */
  addRemote: (path: string, name: string, url: string) =>
    invoke<string>("add_remote", { path, name, url }),

  /** Repoint an existing remote at a new `url` (`git remote set-url`). */
  setRemoteUrl: (path: string, name: string, url: string) =>
    invoke<string>("set_remote_url", { path, name, url }),

  /** Rewrite only a remote's HTTPS username, preserving distinct fetch/push URLs. */
  setRemoteUsername: (path: string, name: string, username?: string | null) =>
    invoke<string>("set_remote_username", { path, name, username: username ?? null }),

  /** Remove a remote (`git remote remove`). */
  removeRemote: (path: string, name: string) =>
    invoke<string>("remove_remote", { path, name }),

  /** Delete a tag on `remote` with an exact ref lease, defaulting to the repo's
   * default push remote, optionally as that remote's bound auth. */
  deleteRemoteTag: (
    path: string,
    name: string,
    expectedOid: string,
    remote?: string | null,
    auth?: GitTransportAuthRef | null,
  ) =>
    invoke<string>("delete_remote_tag", {
      path,
      name,
      expectedOid,
      remote: remote ?? null,
      auth: auth ?? null,
    }),

  /** Push a tag to `remote` (defaulting to the repo's default push remote),
   * optionally as that remote's bound auth. */
  pushTag: (
    path: string,
    name: string,
    remote?: string | null,
    auth?: GitTransportAuthRef | null,
  ) =>
    invoke<string>("push_tag", {
      path,
      name,
      remote: remote ?? null,
      auth: auth ?? null,
    }),

  /** Delete `branch` on `remote` (`git push <remote> --delete`), optionally as
   * the repo's bound auth. `branch` is the short name (no `remote/` prefix). */
  deleteRemoteBranch: (
    path: string,
    remote: string,
    branch: string,
    expectedOid: string,
    auth?: GitTransportAuthRef | null,
  ) => invoke<string>("delete_remote_branch", { path, remote, branch, expectedOid, auth: auth ?? null }),

  /** Force-push a specific `branch` with the exact route/source/destination
   * lease returned by previewForcePush, optionally as the bound auth. */
  forcePush: (
    path: string,
    branch: string,
    expectedOid: string,
    route: ForcePushRouteLease,
    auth?: GitTransportAuthRef | null,
  ) => invoke<string>("force_push", {
    path,
    branch,
    expectedOid,
    route: {
      remote: route.remote,
      destinationRef: route.destinationRef,
      destinationOid: route.destinationOid,
      pushEndpointToken: route.pushEndpointToken,
    },
    auth: auth ?? null,
  }),

  pull: (path: string, branch: string, expectedOid: string, auth?: GitTransportAuthRef | null) =>
    invoke<string>("pull", { path, branch, expectedOid, auth: auth ?? null }),

  /** Fetch + prune every non-skipped remote, each authenticated as its own
   * bound account (GL-129). `remoteAccounts` carries one `{remote, account}`
   * pair per bound remote; unlisted remotes fall back to the system credential
   * helpers / SSH. */
  fetch: (path: string, remoteAccounts?: RemoteAccountRef[]) =>
    invoke<string>("fetch", { path, remoteAccounts: remoteAccounts ?? [] }),

  /** Push a specific (possibly not-checked-out) `branch` to its configured
   * remote (origin fallback), optionally as the target remote's bound auth. */
  pushBranch: (path: string, branch: string, expectedOid: string, auth?: GitTransportAuthRef | null) =>
    invoke<string>("push_branch", { path, branch, expectedOid, auth: auth ?? null }),

  /** First-push flow: create/update `upstream` (`remote/branch`) and set it as
   * `branch`'s upstream in the same git push. */
  publishBranch: (
    path: string,
    branch: string,
    expectedOid: string,
    upstream: string,
    auth?: GitTransportAuthRef | null,
  ) => invoke<string>("publish_branch", { path, branch, expectedOid, upstream, auth: auth ?? null }),
};
