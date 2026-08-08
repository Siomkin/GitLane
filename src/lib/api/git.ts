// Facade over the git half of the IPC surface. The typed `invoke()` wrappers
// live in focused modules under `git/`, one per Rust `commands/*.rs` module, and
// the serde types they return live in `git/types.ts` — the same shape the
// backend has (thin per-domain command modules over a shared `git/types/`).
//
// Splitting the wrappers by their *owning command module* rather than by an
// invented taxonomy means the two sides stay checkable against each other: every
// name a module here invokes is declared in the Rust module it is named for.

export * from "./git/types";

import { branchesApi } from "./git/branches";
import { commitsApi } from "./git/commits";
import { conflictsApi } from "./git/conflicts";
import { filesApi } from "./git/files";
import { identityApi } from "./git/identity";
import { recoveryApi } from "./git/recovery";
import { remotesApi } from "./git/remotes";
import { repoApi } from "./git/repo";
import { stagingApi } from "./git/staging";
import { statusApi } from "./git/status";
import { tagsApi } from "./git/tags";
import { worktreesApi } from "./git/worktrees";

export const gitApi = {
  ...repoApi,
  ...remotesApi,
  ...branchesApi,
  ...worktreesApi,
  ...recoveryApi,
  ...conflictsApi,
  ...tagsApi,
  ...filesApi,
  ...statusApi,
  ...stagingApi,
  ...commitsApi,
  ...identityApi,
};
