// The repo store's type surface, split by what it describes: the view-state
// shapes (`views`), the published git data (`data`), the non-write actions
// (`actions`), and the git write actions (`writeActions`).

import type { StoreApi } from "zustand";

import type { RepoActions } from "./repoTypes/actions";
import type { RepoDataState } from "./repoTypes/data";
import type { RepoWriteActions } from "./repoTypes/writeActions";

export * from "./repoTypes/views";
export * from "./repoTypes/data";
export type { RepoActions } from "./repoTypes/actions";
export type { RepoWriteActions } from "./repoTypes/writeActions";

export interface RepoState extends RepoDataState, RepoActions, RepoWriteActions {}

export type RepoSet = StoreApi<RepoState>["setState"];
export type RepoGet = StoreApi<RepoState>["getState"];
