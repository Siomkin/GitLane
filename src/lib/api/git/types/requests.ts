// Request objects for the multi-field write commands. Mirrors
// `src-tauri/src/git/types/requests.rs`. Optional expectations are absent
// fields — the same meaning as the old positional `null`.

import type { CapturedIdentity } from "./repo";

export interface CommitRequest {
  expectedBranch?: string;
  expectedOid?: string;
  summary: string;
  description: string;
  amend: boolean;
  name?: string;
  email?: string;
  identity: CapturedIdentity;
}

export interface SquashCommitsRequest {
  expectedBranch?: string;
  expectedOid: string;
  parentOid: string;
  summary: string;
  description: string;
  name?: string;
  email?: string;
  identity: CapturedIdentity;
}

export interface SquashRangeRequest {
  expectedBranch?: string;
  expectedOid: string;
  newestOid: string;
  parentOid: string;
  summary: string;
  description: string;
  name?: string;
  email?: string;
  identity: CapturedIdentity;
}

export interface SquashBranchRequest {
  expectedBranch: string;
  expectedOid: string;
  newestOid: string;
  parentOid: string;
  summary: string;
  description: string;
  name?: string;
  email?: string;
  identity: CapturedIdentity;
}

export interface ApplyLineRequest {
  file: string;
  staged: boolean;
  hunkIndex: number;
  lineIndex: number;
  expectedKind: string;
  expectedContent: string;
  expectedOldNo?: number;
  expectedNewNo?: number;
}

export interface ResetToRequest {
  source?: string;
  expectedSourceOid?: string;
  targetOid: string;
  mode: "soft" | "mixed" | "hard";
  expectedState?: string;
  expectedHeadBranch?: string;
  expectedHeadOid?: string;
}
