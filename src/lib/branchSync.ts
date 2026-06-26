import type { BranchInfo, BranchSyncState, RepoSummary } from "./api";

export interface CurrentBranchSyncView {
  label: string | null;
  title: string;
  canPull: boolean;
  canPush: boolean;
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
      return null;
    case "unknown":
      return null;
  }
};

export const syncTitle = (sync?: BranchSyncState | null): string => {
  if (!sync) return "Sync state is still loading.";
  const upstream = sync.upstream ?? "upstream";
  switch (sync.status) {
    case "upToDate":
      return `Up to date with ${upstream}.`;
    case "ahead":
      return `${sync.ahead} commit${plural(sync.ahead)} ahead of ${upstream}.`;
    case "behind":
      return `${sync.behind} commit${plural(sync.behind)} behind ${upstream}.`;
    case "diverged":
      return `${sync.ahead} ahead and ${sync.behind} behind ${upstream}. Rebase or merge before syncing.`;
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
  if (!summary) {
    return {
      label: null,
      title: "Open a repository to sync branches.",
      canPull: false,
      canPush: false,
      needsPublishPrompt: false,
    };
  }
  if (summary.detached) {
    return {
      label: null,
      title: "Detached HEAD has no branch upstream. Check out a branch before pulling or pushing.",
      canPull: false,
      canPush: false,
      needsPublishPrompt: false,
    };
  }
  if (!summary.headBranch) {
    return {
      label: null,
      title: "No branch is checked out.",
      canPull: false,
      canPush: false,
      needsPublishPrompt: false,
    };
  }

  const branch = branches.find((item) => item.kind === "local" && item.name === summary.headBranch);
  const sync = branch?.sync;
  if (!sync) {
    return {
      label: null,
      title: "Sync state is unavailable. Pull or push will let git validate the operation.",
      canPull: true,
      canPush: true,
      needsPublishPrompt: false,
    };
  }

  return {
    label: syncBadgeLabel(sync),
    title: syncTitle(sync),
    canPull: canPull(sync),
    canPush: canPush(sync),
    needsPublishPrompt: sync.status === "noUpstream" || sync.status === "staleUpstream",
  };
};

const canPull = (sync: BranchSyncState) =>
  !["noRemote", "noUpstream", "staleUpstream"].includes(sync.status);

const canPush = (sync: BranchSyncState) =>
  sync.status === "ahead" ||
  sync.status === "diverged" ||
  sync.status === "unknown" ||
  sync.status === "noUpstream" ||
  sync.status === "staleUpstream";

const plural = (count: number) => (count === 1 ? "" : "s");
