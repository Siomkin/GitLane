// Facade over the repo write actions. The 60-odd actions live in focused slices
// under `repoWriteActions/`, split the same way the Rust `git/write/` modules
// are (GL-341); this file only composes them, so `repo.ts` keeps one import
// site. Each slice declares its own `Pick<RepoState, …>`, so the composed type
// is inferred from the spread.

import { createBranchActions } from "./repoWriteActions/branches";
import { createCheckoutActions } from "./repoWriteActions/checkout";
import { createCommitActions } from "./repoWriteActions/commits";
import { createFileActions } from "./repoWriteActions/files";
import { createHistoryActions } from "./repoWriteActions/history";
import { createPatchActions } from "./repoWriteActions/patches";
import { createRemoteActions } from "./repoWriteActions/remotes";
import { createStagingActions } from "./repoWriteActions/staging";
import { createStashActions } from "./repoWriteActions/stashes";
import { createTagActions } from "./repoWriteActions/tags";
import { createWorktreeActions } from "./repoWriteActions/worktrees";
import type { RepoGet, RepoSet } from "./repoTypes";

export function createRepoWriteActions(set: RepoSet, get: RepoGet) {
  return {
    ...createCheckoutActions(set, get),
    ...createBranchActions(get),
    ...createHistoryActions(get),
    ...createTagActions(set, get),
    ...createPatchActions(get),
    ...createStashActions(get),
    ...createWorktreeActions(set, get),
    ...createStagingActions(set, get),
    ...createFileActions(get),
    ...createCommitActions(set, get),
    ...createRemoteActions(set, get),
  };
}
