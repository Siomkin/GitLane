import { BranchKind, headStateOf, type BranchInfo, type BranchSyncState, type RepoSummary } from "./api";
import { remoteNameForUpstream } from "./remoteAccounts";
import { shortName } from "./remoteBranches";

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

  const publishNamesake = shouldPublishNamesake(branch, branches);
  const title = !publishNamesake
    ? syncTitle(sync)
    : hasSameNameRemote(branch, branches)
      ? `${head.branch} tracks ${sync.upstream ?? "another branch"} instead of its own remote branch. Push will ask where to publish.`
      : `${head.branch} tracks ${sync.upstream ?? "another branch"} and has no remote of the same name yet. Push will publish it.`;
  return {
    label: syncBadgeLabel(sync),
    title,
    canPull: canPull(sync),
    canPush: canPush(sync) || publishNamesake,
    canForcePush: !publishNamesake && canForcePush(sync),
    needsPublishPrompt:
      sync.status === "noUpstream" || sync.status === "staleUpstream" || publishNamesake,
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
// A branch that tracks a *differently-named* remote is also routed to Publish
// (handled in `currentBranchSyncView`).
const canPush = (sync: BranchSyncState) =>
  sync.status === "ahead" ||
  sync.status === "unknown" ||
  sync.status === "noUpstream" ||
  sync.status === "staleUpstream";

// A plain `git push` is rejected non-fast-forward when `diverged`. That case is
// served by `--force-with-lease` from the toolbar (and still from the branch
// menu). `noUpstream` / `staleUpstream` stay on the publish prompt, not this.
const canForcePush = (sync: BranchSyncState) => sync.status === "diverged";

const LIVE_MISMATCH_SYNC_STATUSES = new Set<BranchSyncState["status"]>([
  "upToDate",
  "ahead",
  "behind",
  "diverged",
]);

/** True when the local branch tracks a differently-named remote and has no
 * explicit push remote overriding that upstream remote. `git checkout -b feat
 * origin/develop` leaves `feat` tracking `develop`; Push (and Commit & Push)
 * should route through the Publish prompt pre-filled with `<remote>/feat`
 * across all live sync states (`upToDate`, `ahead`, `behind`, `diverged`) —
 * even if `<remote>/feat` already exists — rather than pushing or
 * force-pushing onto `develop`. Triangular fork setups
 * (`pushRemote !== upstreamRemote`) already push to `<pushRemote>/<local>` in
 * the write layer and are left untouched. */
export const shouldPublishNamesake = (
  branch: BranchInfo | undefined,
  branches: BranchInfo[],
): boolean => {
  if (!branch || branch.kind !== BranchKind.Local) return false;
  if (!branch.sync || !LIVE_MISMATCH_SYNC_STATUSES.has(branch.sync.status)) return false;
  const remoteNames = remoteNamesOf(branches);
  const upstream = branch.sync.upstream ?? branch.upstream;
  if (!upstream) return false;
  const upstreamRemote =
    branch.upstreamRemote ?? remoteNameForUpstream(upstream, remoteNames);
  if (branch.pushRemote && upstreamRemote && branch.pushRemote !== upstreamRemote) {
    return false;
  }
  const tracked = trackedBranchName(branch, remoteNames);
  return Boolean(tracked && tracked !== branch.name);
};

const hasSameNameRemote = (branch: BranchInfo, branches: BranchInfo[]): boolean => {
  const remoteNames = remoteNamesOf(branches);
  const upstream = branch.sync?.upstream ?? branch.upstream;
  const upstreamRemote =
    branch.upstreamRemote ?? (upstream ? remoteNameForUpstream(upstream, remoteNames) : null);
  const targetRemote =
    upstreamRemote && upstreamRemote !== "."
      ? upstreamRemote
      : fallbackRemote(remoteNames);
  return branches.some(
    (item) =>
      item.kind === BranchKind.Remote &&
      remoteOfBranch(item, remoteNames) === targetRemote &&
      shortName(item) === branch.name,
  );
};

/** Whether the publish prompt should pre-fill the configured upstream. Stale
 * remotes and mismatched upstreams both retarget to `<remote>/<local>`
 * (keeping the configured remote). */
export const publishUsesConfiguredUpstream = (
  branch: BranchInfo | undefined,
  branches: BranchInfo[],
): boolean => {
  if (!branch) return true;
  if (branch.sync?.status === "staleUpstream") return false;
  return !shouldPublishNamesake(branch, branches);
};

const trackedBranchName = (branch: BranchInfo, remoteNames: string[]): string | null => {
  const upstream = branch.sync?.upstream ?? branch.upstream;
  if (!upstream) return null;
  if (branch.upstreamRemote === ".") return upstream;
  const remote = branch.upstreamRemote ?? remoteNameForUpstream(upstream, remoteNames);
  return remote && upstream.startsWith(`${remote}/`) ? upstream.slice(remote.length + 1) : upstream;
};

export const remoteOfBranch = (branch: BranchInfo, remoteNames: string[]): string | null =>
  branch.remote ?? remoteNameForUpstream(branch.name, remoteNames);

const fallbackRemote = (remoteNames: string[]): string =>
  remoteNames.includes("origin") ? "origin" : remoteNames[0] ?? "origin";

/** Remote names as the backend resolved them (`BranchInfo.remote`), so a
 * remote containing a slash is never split on its first one. */
export const remoteNamesOf = (branches: BranchInfo[]): string[] => [
  ...new Set(
    branches.flatMap((b) => (b.kind === BranchKind.Remote && b.remote ? [b.remote] : [])),
  ),
];

export interface PublishTargetDefault {
  /** Pre-filled `remote/branch` string for the publish prompt. */
  target: string;
  /** Explicit remote matching `target`, passed to `publish_branch` when the
   * user accepts the default so a longer slashed remote name cannot hijack it. */
  remote: string;
}

/** Resolve both the default `remote/branch` prompt value and its explicit
 * remote from one source. Prefers the backend-resolved `upstreamRemote`
 * (ignoring Git's `.` local-tracking pseudo-remote) so a longer slashed remote
 * like `origin/feat` cannot hijack `origin/feat/base`, and a `.`-remote
 * slashed local branch never turns its first path segment into a remote name. */
export const resolveDefaultPublishTarget = (
  branches: BranchInfo[],
  branchName: string,
  upstream?: string | null,
  upstreamResolves = true,
  upstreamRemote?: string | null,
): PublishTargetDefault => {
  const remoteNames = remoteNamesOf(branches);
  const resolvedRemote =
    upstreamRemote && upstreamRemote !== "."
      ? upstreamRemote
      : upstream && upstreamRemote !== "."
        ? remoteNameForUpstream(upstream, remoteNames)
        : null;
  if (upstream && upstreamResolves) {
    return {
      target: upstream,
      remote: resolvedRemote ?? fallbackRemote(remoteNames),
    };
  }
  const remote = resolvedRemote ?? fallbackRemote(remoteNames);
  return {
    target: `${remote}/${branchName}`,
    remote,
  };
};

/** The default `remote/branch` to pre-fill a publish prompt with. Prefers the
 * branch's configured upstream, then a remote named `origin`, then the first
 * remote present in the branch list — so multi-remote repos get a stable,
 * predictable default rather than whichever remote-tracking ref sorts first.
 *
 * Pass `upstreamResolves: false` when the configured upstream is *stale* (its
 * remote ref was pruned) or covered by {@link shouldPublishNamesake}. */
export const defaultPublishTarget = (
  branches: BranchInfo[],
  branchName: string,
  upstream?: string | null,
  upstreamResolves = true,
  upstreamRemote?: string | null,
): string =>
  resolveDefaultPublishTarget(
    branches,
    branchName,
    upstream,
    upstreamResolves,
    upstreamRemote,
  ).target;

/** The remote half of {@link defaultPublishTarget}, derived from the same
 * resolution so a longer slashed remote name cannot hijack it. */
export const defaultPublishRemote = (
  branches: BranchInfo[],
  upstream?: string | null,
  upstreamRemote?: string | null,
): string =>
  resolveDefaultPublishTarget(branches, "", upstream, false, upstreamRemote).remote;

const plural = (count: number) => (count === 1 ? "" : "s");
