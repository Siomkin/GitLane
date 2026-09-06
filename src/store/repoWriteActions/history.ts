// History rewrites and grafts: merge, fast-forward, rebase, reset, cherry-pick,
// revert, squash. Everything here can stop on conflicts, so most run through
// `runMaybeConflict`.

import { api } from "@/lib/api";
import { capturedIdentityArg } from "@/lib/api/git/capturedIdentity";
import { splitCommitMessage } from "@/lib/commitMessage";
import { mergeWasAlreadyUpToDate } from "@/lib/mergeOutcome";
import { useAccounts } from "@/store/accounts";
import { validateSquashRange } from "@/store/selection";
import type { RepoGet, RepoState } from "@/store/repoTypes";
import {
  captureOwner,
  commitSetIsCurrent,
  localBranchOid,
  ownerIsCurrent,
  requireHeadOid,
  revisionSnapshot,
  runMaybeConflict,
  runOp,
} from "./shared";

export function createHistoryActions(
  get: RepoGet,
): Pick<
  RepoState,
  | "mergeInto"
  | "fastForwardTo"
  | "rebaseOnto"
  | "resetBranchTo"
  | "cherryPickCommit"
  | "revertCommit"
  | "cherryPickMany"
  | "revertMany"
  | "squashSelection"
> {
  return {
    mergeInto: (from, to) =>
      runMaybeConflict(
        get,
        async (summary) => {
          const source = revisionSnapshot(get, from);
          const detachedDestination = to === "HEAD" && summary.headBranch === null;
          const destination = detachedDestination ? null : to;
          const destinationOid = detachedDestination
            ? requireHeadOid(summary, "merge")
            : localBranchOid(get, to);
          const output = await api.mergeBranch(
            summary.path,
            source.revision,
            source.oid,
            destination,
            destinationOid,
          );
          // Even under `--no-ff`, git exits 0 and creates nothing when `from`
          // is already reachable from HEAD (equal tips included) — the toast
          // must not claim a merge happened.
          return mergeWasAlreadyUpToDate(output)
            ? `${to} is already up to date with ${from}`
            : `Merged ${from} into ${to}`;
        },
        `Merging ${from} into ${to}`,
      ),

    // `from` is the rev to advance to; `to` is the branch being moved forward.
    // When `to` is the checked-out branch, fast-forward it in the working tree
    // (`merge --ff-only`). Otherwise move its ref in place without a disruptive
    // checkout — so e.g. advancing develop to origin/develop never yanks you off
    // the branch you're working on.
    fastForwardTo: (from, to) =>
      runOp(get, async (summary) => {
        const target = revisionSnapshot(get, from);
        await api.fastForwardBranch(summary.path, to, localBranchOid(get, to), target.oid);
        return `Fast-forwarded ${to} to ${from}`;
      }),

    rebaseOnto: (source, onto) =>
      runMaybeConflict(
        get,
        async (summary) => {
          const sourceSnapshot = source === "HEAD"
            ? revisionSnapshot(get, source)
            : { revision: source, oid: localBranchOid(get, source) };
          const target = revisionSnapshot(get, onto);
          await api.rebaseOnto(
            summary.path,
            sourceSnapshot.revision,
            sourceSnapshot.oid,
            target.oid,
          );
          return `Rebased ${source} onto ${onto}`;
        },
        `Rebasing ${source} onto ${onto}`,
      ),

    resetBranchTo: (source, target, mode, preview) =>
      runOp(get, async (summary) => {
        // Always pass the previewed tips — never live store OIDs that can drift
        // after the confirmation dialog opened and weaken the backend lease.
        if (!preview.targetOid) {
          throw new Error("Reset requires the previewed target commit. Preview again.");
        }
        if (source !== null && !preview.expectedSourceOid) {
          throw new Error("The branch has no expected commit. Refresh and try again.");
        }
        if (mode === "hard" && !preview.expectedState) {
          throw new Error(
            "Hard reset requires the exact-state lease from its confirmation. Preview again.",
          );
        }
        await api.resetTo(summary.path, {
          source: source ?? undefined,
          expectedSourceOid: preview.expectedSourceOid ?? undefined,
          targetOid: preview.targetOid,
          mode,
          expectedState: preview.expectedState ?? undefined,
          expectedHeadBranch: preview.expectedHeadBranch ?? undefined,
          expectedHeadOid: preview.expectedHeadOid ?? undefined,
        });
        return `Reset ${source ?? "HEAD"} to ${target}`;
      }),

    cherryPickCommit: (sha) =>
      runMaybeConflict(
        get,
        async (summary) => {
          await api.cherryPickMany(
            summary.path,
            summary.headBranch,
            requireHeadOid(summary, "cherry-pick"),
            [sha],
          );
          return `Cherry-picked ${sha.slice(0, 7)}`;
        },
        `Cherry-picking ${sha.slice(0, 7)}`,
      ),

    revertCommit: (sha) =>
      runMaybeConflict(
        get,
        async (summary) => {
          await api.revertMany(
            summary.path,
            summary.headBranch,
            requireHeadOid(summary, "revert"),
            [sha],
          );
          return `Reverted ${sha.slice(0, 7)}`;
        },
        `Reverting ${sha.slice(0, 7)}`,
      ),

    cherryPickMany: async (shas) => {
      if (shas.length === 0) throw new Error("No commits selected");
      const active = get().summary;
      if (!active) throw new Error("No repository");
      const owner = captureOwner(active);
      const selectedCommits = get().selectedCommits;
      const n = shas.length;
      const msg = await runMaybeConflict(
        get,
        async (summary) => {
          await api.cherryPickMany(
            summary.path,
            summary.headBranch,
            requireHeadOid(summary, "cherry-pick"),
            shas,
          );
          return `Cherry-picked ${n} commit${n === 1 ? "" : "s"}`;
        },
        `Cherry-picking ${n} commit${n === 1 ? "" : "s"}`,
      );
      if (ownerIsCurrent(get, owner) && commitSetIsCurrent(get, selectedCommits)) {
        get().clearSelection();
      }
      return msg;
    },

    revertMany: async (shas) => {
      if (shas.length === 0) throw new Error("No commits selected");
      const active = get().summary;
      if (!active) throw new Error("No repository");
      const owner = captureOwner(active);
      const selectedCommits = get().selectedCommits;
      const n = shas.length;
      const msg = await runMaybeConflict(
        get,
        async (summary) => {
          await api.revertMany(
            summary.path,
            summary.headBranch,
            requireHeadOid(summary, "revert"),
            shas,
          );
          return `Reverted ${n} commit${n === 1 ? "" : "s"}`;
        },
        `Reverting ${n} commit${n === 1 ? "" : "s"}`,
      );
      if (ownerIsCurrent(get, owner) && commitSetIsCurrent(get, selectedCommits)) {
        get().clearSelection();
      }
      return msg;
    },

    squashSelection: async (shas, message, target) => {
      const active = get().summary;
      if (!active) throw new Error("No repository");
      const owner = captureOwner(active);
      const selectedCommits = get().selectedCommits;
      const msg = await runOp(
        get,
        async (summary) => {
          if (target && summary.path !== target.repoPath) {
            throw new Error("Repository changed. Refresh and try again.");
          }
          const graph = get().graph;
          const { parent, newest, atTip } = validateSquashRange(
            target && graph ? { ...graph, head: target.oid } : graph, shas,
          );
          const expectedOid = target?.oid ?? requireHeadOid(summary, "squash commits");
          const identity = useAccounts.getState().repoIdentity;
          const { summary: subject, description } = splitCommitMessage(message);
          const identityFields = {
            name: identity?.name,
            email: identity?.email,
            identity: capturedIdentityArg(identity),
          };
          // Below the tip the commits above the range have to be replayed onto
          // the replacement, which is a different write path entirely.
          await (target
            ? api.squashBranch(summary.path, {
                expectedBranch: target.branch,
                expectedOid: target.oid,
                newestOid: newest,
                parentOid: parent,
                summary: subject,
                description,
                ...identityFields,
              })
            : atTip
            ? api.squashCommits(summary.path, {
                expectedBranch: summary.headBranch ?? undefined,
                expectedOid,
                parentOid: parent,
                summary: subject,
                description,
                ...identityFields,
              })
            : api.squashRange(summary.path, {
                expectedBranch: summary.headBranch ?? undefined,
                expectedOid,
                newestOid: newest,
                parentOid: parent,
                summary: subject,
                description,
                ...identityFields,
              }));
          return `Squashed ${shas.length} commits`;
        },
        // Squash preserves pre-staged work by restoring an index snapshot after
        // the commit (GL-307), so it can reject *after* the replacement commit
        // already landed. Refresh on error like the guarded discard does, or the
        // graph keeps showing the pre-squash range until the watcher catches up.
        { refreshOnError: true },
      );
      if (ownerIsCurrent(get, owner) && commitSetIsCurrent(get, selectedCommits)) {
        get().clearSelection();
      }
      return msg;
    },
  };
}
