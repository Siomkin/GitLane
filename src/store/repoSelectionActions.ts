// Facade over the selection actions (GL-357 shape): what the workspace has
// selected, split by route into `repoSelection/`. Commit/WIP/file selection,
// the file-history route, and the compare route each own their own module; the
// latest-start request registries they share live in `repoSelection/generations`.

import { createCommitSelectionActions } from "./repoSelection/commits";
import { createCompareActions } from "./repoSelection/compare";
import { createFileHistoryActions } from "./repoSelection/fileHistory";
import {
  createCompareGenerations,
  createFileHistoryGenerations,
} from "./repoSelection/generations";
import type { RepoGet, RepoSet } from "./repoTypes";

export function createRepoSelectionActions(set: RepoSet, get: RepoGet) {
  const fileHistoryGen = createFileHistoryGenerations();
  const compareGen = createCompareGenerations();
  return {
    ...createCommitSelectionActions(set, get, fileHistoryGen),
    ...createFileHistoryActions(set, get, fileHistoryGen),
    ...createCompareActions(set, get, fileHistoryGen, compareGen),
  };
}
