// The configured remotes and everything that talks to one: forge detection,
// remote CRUD, fetch/pull/push, publish, force-push, and the remote-side branch
// and tag deletes. Mirrors `commands/remotes.rs`.

import { invoke } from "@/lib/api/invoke";
import { remoteInfoSchema, repoForgeSchema } from "@/lib/api/schemas";
import { parse } from "@/lib/api/validate";
import { z } from "zod";
import type {
  ForcePushRouteLease,
  GitTransportAuthRef,
  RemoteAccountRef,
  RemoteInfo,
  RepoForge,
} from "./types";

export const remotesApi = {
  /** Detect the open repo's remote forge for the toolbar provider indicator. */
  repoForge: async (path: string): Promise<RepoForge> =>
    parse(repoForgeSchema, await invoke("repo_forge", { path }), "repo_forge"),

  /** List the repo's configured remotes (Repository settings → Remotes). */
  listRemotes: async (path: string): Promise<RemoteInfo[]> =>
    parse(z.array(remoteInfoSchema), await invoke("list_remotes", { path }), "list_remotes"),

  /** Add a new remote `name` → `url` (`git remote add`). */
  addRemote: async (path: string, name: string, url: string) =>
    parse(z.string(), await invoke("add_remote", { path, name, url }), "add_remote"),

  /** Repoint an existing remote at a new `url` (`git remote set-url`). */
  setRemoteUrl: async (path: string, name: string, url: string) =>
    parse(z.string(), await invoke("set_remote_url", { path, name, url }), "set_remote_url"),

  /** Rewrite only a remote's HTTPS username, preserving distinct fetch/push URLs. */
  setRemoteUsername: async (path: string, name: string, username?: string | null) =>
    parse(
      z.string(),
      await invoke("set_remote_username", { path, name, username: username ?? null }),
      "set_remote_username",
    ),

  /** Remove a remote (`git remote remove`). */
  removeRemote: async (path: string, name: string) =>
    parse(z.string(), await invoke("remove_remote", { path, name }), "remove_remote"),

  /** Delete a tag on `remote` with an exact ref lease, defaulting to the repo's
   * default push remote, optionally as that remote's bound auth. */
  deleteRemoteTag: async (
    path: string,
    name: string,
    expectedOid: string,
    remote?: string | null,
    auth?: GitTransportAuthRef | null,
  ) =>
    parse(
      z.string(),
      await invoke("delete_remote_tag", {
        path,
        name,
        expectedOid,
        remote: remote ?? null,
        auth: auth ?? null,
      }),
      "delete_remote_tag",
    ),

  /** Push a tag to `remote` (defaulting to the repo's default push remote),
   * optionally as that remote's bound auth. */
  pushTag: async (
    path: string,
    name: string,
    remote?: string | null,
    auth?: GitTransportAuthRef | null,
  ) =>
    parse(
      z.string(),
      await invoke("push_tag", { path, name, remote: remote ?? null, auth: auth ?? null }),
      "push_tag",
    ),

  /** Delete `branch` on `remote` (`git push <remote> --delete`), optionally as
   * the repo's bound auth. `branch` is the short name (no `remote/` prefix). */
  deleteRemoteBranch: async (
    path: string,
    remote: string,
    branch: string,
    expectedOid: string,
    auth?: GitTransportAuthRef | null,
  ) =>
    parse(
      z.string(),
      await invoke("delete_remote_branch", {
        path,
        remote,
        branch,
        expectedOid,
        auth: auth ?? null,
      }),
      "delete_remote_branch",
    ),

  /** Force-push a specific `branch` with the exact route/source/destination
   * lease returned by previewForcePush, optionally as the bound auth. */
  forcePush: async (
    path: string,
    branch: string,
    expectedOid: string,
    route: ForcePushRouteLease,
    auth?: GitTransportAuthRef | null,
  ) =>
    parse(
      z.string(),
      await invoke("force_push", {
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
      "force_push",
    ),

  pull: async (path: string, branch: string, expectedOid: string, auth?: GitTransportAuthRef | null) =>
    parse(
      z.string(),
      await invoke("pull", { path, branch, expectedOid, auth: auth ?? null }),
      "pull",
    ),

  /** Fetch + prune every non-skipped remote, each authenticated as its own
   * bound account (GL-129). `remoteAccounts` carries one `{remote, account}`
   * pair per bound remote; unlisted remotes fall back to the system credential
   * helpers / SSH. */
  fetch: async (path: string, remoteAccounts?: RemoteAccountRef[]) =>
    parse(
      z.string(),
      await invoke("fetch", { path, remoteAccounts: remoteAccounts ?? [] }),
      "fetch",
    ),

  /** Push a specific (possibly not-checked-out) `branch` to its configured
   * remote (origin fallback), optionally as the target remote's bound auth. */
  pushBranch: async (
    path: string,
    branch: string,
    expectedOid: string,
    auth?: GitTransportAuthRef | null,
  ) =>
    parse(
      z.string(),
      await invoke("push_branch", { path, branch, expectedOid, auth: auth ?? null }),
      "push_branch",
    ),

  /** First-push flow: create/update `upstream` (`remote/branch`) and set it as
   * `branch`'s upstream in the same git push. */
  publishBranch: async (
    path: string,
    branch: string,
    expectedOid: string,
    upstream: string,
    auth?: GitTransportAuthRef | null,
  ) =>
    parse(
      z.string(),
      await invoke("publish_branch", { path, branch, expectedOid, upstream, auth: auth ?? null }),
      "publish_branch",
    ),
};
