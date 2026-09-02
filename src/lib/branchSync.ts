import { BranchKind, headStateOf, type BranchInfo, type BranchSyncState, type RepoSummary } from "./api";

export interface CurrentBranchSyncView {
  label: string | null;
  title: string;
  canPull: boolean;
  canPush: boolean;
  /** Leased force-push is offered from the push chrome when histories diverged. */
  canForcePush: boolean;
  needsPublishPrompt: boolean;
}

export const syncBadgeLabel = (sync?: BranchSyncState | null): string | null => {
  if (!sync) return null;
  switch (sync.status) {
    case "upToDate":
      return null;
    case "ahead":
      return `↑${sync.ahead}`;
    case "behind":
      return `↓${sync.behind}`;
    case "diverged":
      return `↑${sync.ahead} ↓${sync.behind}`;
    case "noRemote":
      return null;
    case "noUpstream":
      return null;
    case "staleUpstream":
      return "stale";
    case "unknown":
      return null;
  }
};

export const syncTitle = (sync?: BranchSyncState | null): string => {
  if (!sync) return "Sync state is unavailable.";
  const upstream = sync.upstream ?? "upstream";
  switch (sync.status) {
    case "upToDate":
      return `Up to date with ${upstream}.`;
    case "ahead":
      return `${sync.ahead} commit${plural(sync.ahead)} ahead of ${upstream}.`;
    case "behind":
      return `${sync.behind} commit${plural(sync.behind)} behind ${upstream}.`;
    case "diverged":
      return `${sync.ahead} ahead and ${sync.behind} behind ${upstream}. Rebase, merge, or force-push with lease from the branch menu (the checked-out branch also gets Force push on the toolbar).`;
    case "noRemote":
      return "No remote is configured for this repository.";
    case "noUpstream":
      return "This branch has no upstream configured.";
    case "staleUpstream":
      return `Configured upstream ${upstream} is missing. Fetch/prune may have removed it.`;
    case "unknown":
      return `Could not compute sync state against ${upstream}. Pull or push will let git validate the operation.`;
  }
};

export const currentBranchSyncView = (
  summary: RepoSummary | null,
  branches: BranchInfo[],
): CurrentBranchSyncView => {
  const head = headStateOf(summary);
  switch (head.kind) {
    case "detached":
      return {
        label: null,
        title: "Detached HEAD has no branch upstream. Check out a branch before pulling or pushing.",
        canPull: false,
        canPush: false,
        canForcePush: false,
        needsPublishPrompt: false,
      };
    // An unborn branch (fresh `git init`, no commits) is a real branch — the
    // backend resolves its name from HEAD's symbolic target — but it has nothing
    // to sync yet and never appears in the branch list, so short-circuit here
    // instead of falling through to the "sync unavailable" path (which would
    // wrongly offer pull/push). GL-115 follow-up.
    case "unborn":
      return {
        label: null,
        title: "This branch has no commits yet. Make the first commit before pulling or pushing.",
        canPull: false,
        canPush: false,
        canForcePush: false,
        needsPublishPrompt: false,
      };
    case "none":
      // No repo open vs. a repo whose HEAD resolves to nothing are both "no
      // head" — only the copy differs.
      return {
        label: null,
        title: summary ? "No branch is checked out." : "Open a repository to sync branches.",
        canPull: false,
        canPush: false,
        canForcePush: false,
        needsPublishPrompt: false,
      };
    case "branch":
      break;
  }

  const branch = branches.find((item) => item.kind === BranchKind.Local && item.name === head.branch);
  const sync = branch?.sync;
  if (!sync) {
    return {
      label: null,
      title: "Sync state is unavailable. Pull or push will let git validate the operation.",
      canPull: true,
      canPush: true,
      canForcePush: false,
      needsPublishPrompt: false,
    };
  }

  return {
    label: syncBadgeLabel(sync),
    title: syncTitle(sync),
    canPull: canPull(sync),
    canPush: canPush(sync),
    canForcePush: canForcePush(sync),
    needsPublishPrompt: sync.status === "noUpstream" || sync.status === "staleUpstream",
  };
};

// A fast-forward pull (`git pull --ff-only`) can only succeed when local history
// is a prefix of the upstream's, so `diverged` is excluded alongside the states
// that have no resolvable upstream — offering it there guarantees a git error.
// `unknown` stays enabled so git itself validates the operation.
const canPull = (sync: BranchSyncState) =>
  !["noRemote", "noUpstream", "staleUpstream", "diverged"].includes(sync.status);

// A plain `git push` is rejected non-fast-forward when `diverged`; that case is
// `canForcePush` on the toolbar (and still in the branch menu). `noUpstream`
// and `staleUpstream` route through the publish prompt (see `needsPublishPrompt`).
const canPush = (sync: BranchSyncState) =>
  sync.status === "ahead" ||
  sync.status === "unknown" ||
  sync.status === "noUpstream" ||
  sync.status === "staleUpstream";

// A plain `git push` is rejected non-fast-forward when `diverged`. That case is
// served by `--force-with-lease` from the toolbar (and still from the branch
// menu). `noUpstream` / `staleUpstream` stay on the publish prompt, not this.
const canForcePush = (sync: BranchSyncState) => sync.status === "diverged";

/** The default `remote/branch` to pre-fill a publish prompt with. Prefers the
 * branch's configured upstream, then a remote named `origin`, then the first
 * remote present in the branch list — so multi-remote repos get a stable,
 * predictable default rather than whichever remote-tracking ref sorts first.
 *
 * Pass `upstreamResolves: false` when the configured upstream is *stale* (its
 * remote ref was pruned): re-publishing the deleted branch name is almost never
 * what the user wants, so only the stale upstream's **remote** is kept and the
 * branch defaults back to the local name (`origin/deleted` → `origin/<branch>`). */
export const defaultPublishTarget = (
  branches: BranchInfo[],
  branchName: string,
  upstream?: string | null,
  upstreamResolves = true,
): string => {
  if (upstream) {
    if (upstreamResolves) return upstream;
    // Keep the configured remote, drop the pruned branch name. A bare upstream
    // (a `.`-remote local-tracking ref, no slash) has no remote to keep — fall
    // through to deriving one from the remote list.
    const slash = upstream.indexOf("/");
    if (slash > 0) return `${upstream.slice(0, slash)}/${branchName}`;
  }
  const remotes = branches
    .filter((b) => b.kind === BranchKind.Remote && b.name.includes("/"))
    .map((b) => b.name.slice(0, b.name.indexOf("/")));
  const remote = remotes.includes("origin") ? "origin" : remotes[0] ?? "origin";
  return `${remote}/${branchName}`;
};

const plural = (count: number) => (count === 1 ? "" : "s");
