// View-model for the AI actions popup: which files the scope chip counts,
// which open PR the result can post to, and the idle-state hint. Pure — no
// React, no IPC. The prompt in `aiActions.ts` still only names revisions;
// these helpers never ship a diff to the agent.

import type { FileChange } from "@/lib/api";
import { PR_STATE, type PrSummary } from "@/lib/prs";
import {
  AiActionScopeKind,
  formatTally,
  mergeFileRows,
  scopeLabel,
  tallyChanges,
  unhandledScope,
  type AiActionScope,
} from "./aiActions";

export const AiActionMenu = {
  None: "none",
  Scope: "scope",
  Action: "action",
} as const;
export type AiActionMenu = (typeof AiActionMenu)[keyof typeof AiActionMenu];

export const AiActionView = {
  Formatted: "formatted",
  Raw: "raw",
} as const;
export type AiActionView = (typeof AiActionView)[keyof typeof AiActionView];

export function sameCommits(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/** Files the scope chip tallies: the working tree when that's the whole pick,
 *  else the already-loaded commit / selection diff when it matches. Empty when
 *  the matching diff hasn't been fetched yet — the chip still names the scope. */
export function filesForScope(
  req: AiActionScope,
  {
    commitFiles,
    selectionDiff,
    changes,
    selectedCommit,
  }: {
    commitFiles: FileChange[];
    selectionDiff: { commits: string[]; files: FileChange[]; workingBase?: string | null } | null;
    changes: { staged: FileChange[]; unstaged: FileChange[]; conflicted: FileChange[] };
    selectedCommit: string | null;
  },
): FileChange[] {
  switch (req.kind) {
    case AiActionScopeKind.Working:
      return mergeFileRows([changes.staged, changes.unstaged, changes.conflicted]);
    case AiActionScopeKind.Commits: {
      const { commits } = req;
      if (selectionDiff && sameCommits(selectionDiff.commits, commits)) return selectionDiff.files;
      if (commits.length === 1 && selectedCommit === commits[0]) return commitFiles;
      return [];
    }
    case AiActionScopeKind.CommitsWithWorking:
      // Working-tree rows are not in any loaded commit diff, so the only honest
      // tally is the union — and never `commitFiles`, which would count the
      // commits while the prompt also asks for the uncommitted changes.
      return selectionDiff && sameCommits(selectionDiff.commits, req.commits)
        ? selectionDiff.files
        : [];
    case AiActionScopeKind.Span:
      // `req` is a snapshot; the store moves on. Matching commits is not enough
      // — the loaded union has to be the one that starts at this same base, or
      // the chip counts a different span than the prompt asks for.
      return selectionDiff &&
        selectionDiff.workingBase === req.base &&
        sameCommits(selectionDiff.commits, req.commits)
        ? selectionDiff.files
        : [];
    case AiActionScopeKind.Range:
      // `git diff base head`, which nothing here has loaded. The commit rules
      // above would tally the head alone and undercount a span of many, so the
      // chip names the range without a number: none beats a wrong one.
      return [];
    default:
      return unhandledScope(req);
  }
}

export function scopeTally(files: FileChange[]): ReturnType<typeof formatTally> | null {
  return files.length > 0 ? formatTally(tallyChanges(files)) : null;
}

export function scopeCommitRows(
  oids: readonly string[],
  commits: readonly { id: string; summary: string }[] | undefined,
): { oid: string; summary: string }[] {
  return oids.map((oid) => ({
    oid,
    summary: commits?.find((commit) => commit.id === oid)?.summary ?? oid,
  }));
}

/** The open PR whose head matches the current branch, or none. */
export function matchingOpenPr(
  pullRequests: readonly PrSummary[],
  headBranch: string | null,
): PrSummary | undefined {
  if (!headBranch) return undefined;
  return pullRequests.find((pr) => pr.branch === headBranch && pr.state === PR_STATE.Open);
}

export function idleHint({
  req,
  tally,
  agentName,
}: {
  req: AiActionScope;
  tally: { stats: string; add: string; del: string } | null;
  agentName: string;
}): string {
  // No tally means the diff isn't loaded (or can't be, for a range) — say the
  // scope once rather than parroting it into the stats slot.
  const stats = tally ? ` (${tally.stats}, ${tally.add} ${tally.del})` : "";
  const what =
    req.kind === AiActionScopeKind.Working ? "the working tree" : scopeLabel(req).toLowerCase();
  return `${agentName} will read ${what}${stats} in the repo and stream the result here.`;
}

export function markClass(status: string): string {
  if (status === "A" || status === "U") return "text-emerald-500 dark:text-emerald-400";
  if (status === "D") return "text-rose-500 dark:text-rose-400";
  return "text-amber-500 dark:text-amber-400";
}
