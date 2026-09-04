// Fixtures shared by the repo-store test files.
//
// `src/store/repo.test.ts` grew to 5 122 lines around one copy of these, which
// is why it was split along the store's own module seams (repoLifecycle,
// repoRefresh, repoSelection, repoTab, repoWriteActions). The `vi.mock` of the
// IPC boundary cannot live here — it is hoisted per file, see
// `src/test/README.md` — but the plain data fixtures can, and duplicating them
// across seven files is how they drift.

import { emptyIpcInvoke } from "@/test/ipcFixtures";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import type { CommitNode, RepoGraph, RepoSummary, WorkingChanges } from "@/lib/api";

/** A minimal summary so actions that require an open repo proceed. */
export const summary: RepoSummary = {
  path: "/repo",
  workdir: "/repo",
  headBranch: "main",
  headOid: null,
  detached: false,
};

export const emptyGraph: RepoGraph = {
  commits: [],
  edges: [],
  laneCount: 1,
  wipLane: null,
  head: null,
  truncated: false,
};

export const EMPTY_CHANGES: WorkingChanges = {
  staged: [],
  unstaged: [],
  conflicted: [],
  advanced: emptyAdvancedState,
};

/** Default invoke result for any command a test doesn't mock explicitly. Most
 *  reads return a list, but `working_changes` is a WorkingChanges object — now
 *  that lib/api validates the IPC shape (GL-57), a catch-all `[]` is rejected at
 *  the seam, so route the fall-through through here. */
export const defaultInvoke = (cmd: string) =>
  cmd === "working_changes" ? Promise.resolve(EMPTY_CHANGES) : emptyIpcInvoke(cmd);

/** Build a complete CommitNode for graph fixtures. lib/api now validates the
 *  commit_graph shape (GL-57), so a partial inline node is rejected at the seam. */
export const node = (over: Partial<CommitNode>): CommitNode => ({
  id: "c",
  shortId: "c",
  summary: "",
  body: "",
  authorName: "",
  authorEmail: "",
  timestamp: 0,
  parents: [],
  lane: 0,
  row: 0,
  refs: [],
  ...over,
});

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
