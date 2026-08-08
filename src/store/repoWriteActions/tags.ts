// Tag writes. Deleting and pushing reach the remote, so they take the shared
// net context rather than owning their own transport rules.

import { api } from "@/lib/api";
import type { RepoGet, RepoSet, RepoState } from "@/store/repoTypes";
import { authFor, trackNet } from "./net";
import { refreshIfCurrent, requireHeadOid, runOp, toastOutcome } from "./shared";

export function createTagActions(
  set: RepoSet,
  get: RepoGet,
): Pick<RepoState, "createTagAt" | "createAnnotatedTagAt" | "deleteTag" | "pushTag"> {
  // The default push remote — tags land there when no remote is picked.
  const defaultRemote = () => get().remotes.find((r) => r.isDefault)?.name ?? "origin";
  return {
    createTagAt: (name, sha) =>
      runOp(get, async (summary) => {
        await api.createTag(summary.path, name, sha ?? requireHeadOid(summary, "create a tag"));
        return `Created tag ${name}`;
      }),

    createAnnotatedTagAt: (name, message, sha) =>
      runOp(get, async (summary) => {
        await api.createAnnotatedTag(
          summary.path,
          name,
          message,
          sha ?? requireHeadOid(summary, "create a tag"),
        );
        return `Created tag ${name}`;
      }),

    deleteTag: (name, expectedOid, alsoRemote = false) =>
      runOp(get, async (summary, owner) => {
        // Remote first: if the remote rejects (auth, protected tag) the local
        // ref survives, so the user retries from an unchanged state instead of
        // a half-deleted one that fetch would resurrect anyway. A never-pushed
        // tag is fine — the backend treats "remote ref does not exist" as the
        // desired end state.
        if (alsoRemote) {
          const remote = defaultRemote();
          const auth = authFor(remote);
          await trackNet(set, get, () =>
            api.deleteRemoteTag(summary.path, name, expectedOid, remote, auth),
          );
          try {
            await api.deleteTag(summary.path, name, expectedOid);
          } catch (e) {
            // The remote has already changed but runOp only refreshes on
            // success — re-sync quietly so the UI reflects whatever state the
            // failed local half left, then name the half-applied state and the
            // remaining step instead of a bare local-delete error.
            await refreshIfCurrent(get, owner, { prs: false, quiet: true });
            const reason = e instanceof Error ? e.message : String(e);
            throw new Error(
              `Deleted ${name} on ${remote}, but the local delete failed: ${reason}. Use “Delete local tag” to finish.`,
            );
          }
          return `Deleted tag ${name} (local and ${remote})`;
        }
        await api.deleteTag(summary.path, name, expectedOid);
        return `Deleted tag ${name}`;
      }),

    pushTag: (name, remote) =>
      runOp(get, async (summary) => {
        const target = remote ?? defaultRemote();
        const auth = authFor(target);
        await trackNet(set, get, () => api.pushTag(summary.path, name, target, auth));
        // Unlike the branch pushes, this leaves no visible trace: the tag row
        // looks identical before and after, so the toast is the only signal
        // that the tag reached the remote.
        return toastOutcome(`Pushed tag ${name} to ${target}`);
      }),
  };
}
