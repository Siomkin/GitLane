// Pure target model for the create-PR form: what a new pull request can be
// opened against, and the stack it would join. No React, no IPC.
//
// A "stack" here is nothing exotic — it is a pull request whose base is another
// open pull request's head branch in the same repository. GitHub renders that
// chain as a stack and merges it bottom-up; GitLane already reads and merges
// those (see `pr-stack/`). This module is the create side: given the refs the
// head branch descends from and the open pull requests, decide whether there is
// a layer to sit on top of, and describe the resulting chain.

import type { AncestorRef } from "@/lib/api";
import type { PullRequest } from "@/lib/prs";

/** Which of the two things a new pull request can target. */
export const PR_TARGET_MODE = {
  /** A branch — the ordinary case. */
  Base: "base",
  /** The head branch of an open pull request, stacking on top of it. */
  Stack: "stack",
} as const;
export type PrTargetMode = (typeof PR_TARGET_MODE)[keyof typeof PR_TARGET_MODE];

/** How a row in the stack map is drawn. */
export const STACK_ROW_KIND = {
  /** The pull request being composed. */
  New: "new",
  /** An existing open pull request in the chain below. */
  Layer: "layer",
  /** The branch the bottom layer targets — not itself a pull request. */
  Trunk: "trunk",
} as const;
export type StackRowKind = (typeof STACK_ROW_KIND)[keyof typeof STACK_ROW_KIND];

export interface StackMapRow {
  key: string;
  kind: StackRowKind;
  /** "L3", "L2"… counted from the trunk. Empty for the trunk row. */
  layer: string;
  branch: string;
  /** "#143", or empty before the new pull request has a number. */
  num: string;
  /** Short state word — "New", "Draft", "Open" — or empty for the trunk. */
  state: string;
  /** Right-aligned detail: commit count for the new row, age for a layer. */
  meta: string;
}

/**
 * The refs to ask the ancestor probe about, mapped back to the pull request
 * each one belongs to.
 *
 * Both the remote-tracking ref and the bare branch name are offered for every
 * open pull request: the remote ref is the accurate comparison for pushed work,
 * but a branch that exists only locally still resolves under its plain name.
 * The probe skips whatever doesn't resolve, so offering both costs nothing and
 * keeps the stack tab working before the first fetch.
 *
 * The pull request whose head *is* the current branch is left out — it is
 * already open, and nothing stacks on itself.
 */
export function stackCandidates(
  openPrs: PullRequest[],
  remote: string | null,
  head: string,
): Map<string, PullRequest> {
  const byRef = new Map<string, PullRequest>();
  for (const pr of openPrs) {
    if (pr.branch === head) continue;
    if (remote) byRef.set(`${remote}/${pr.branch}`, pr);
    byRef.set(pr.branch, pr);
  }
  return byRef;
}

/**
 * The nearest open pull request the head branch could stack on.
 *
 * `ancestors` arrives nearest-first from the backend, so the first one that
 * maps to an open pull request is the layer this work was cut from. Returns
 * null when nothing matches, which is the ordinary "target a branch" case
 * rather than an error.
 *
 * Only open pull requests are ever in `byRef` — a merged or closed one may
 * still be an ancestor, but targeting it would open a pull request against a
 * base nobody is going to merge.
 */
export function stackParent(
  ancestors: AncestorRef[],
  byRef: Map<string, PullRequest>,
): StackParent | null {
  for (const ancestor of ancestors) {
    const pr = byRef.get(ancestor.name);
    if (pr) return { pr, ref: ancestor.name };
  }
  return null;
}

export interface StackParent {
  pr: PullRequest;
  /** The ref that actually resolved — a remote-tracking ref when the branch
   * isn't checked out locally. Local reads must use this; the forge is told
   * `pr.branch`, since a pull request targets a branch, not a tracking ref. */
  ref: string;
}

/**
 * The chain below `parent`, bottom layer last.
 *
 * Walks base -> head links through the open pull requests: each layer's base is
 * the head branch of the layer beneath it. Stops at the first base that is not
 * another open pull request's head — that base is the trunk.
 *
 * Guarded against a cycle (a pair of pull requests targeting each other's
 * branches is invalid but expressible) by refusing to visit a number twice.
 */
export function stackChain(parent: PullRequest, openPrs: PullRequest[]): PullRequest[] {
  const chain: PullRequest[] = [parent];
  const seen = new Set<number>([parent.num]);
  for (;;) {
    const below = openPrs.find((pr) => pr.branch === chain[chain.length - 1].base);
    if (!below || seen.has(below.num)) return chain;
    seen.add(below.num);
    chain.push(below);
  }
}

/** The branch the bottom of `chain` targets. */
export function stackTrunk(chain: PullRequest[]): string {
  return chain[chain.length - 1].base;
}

/**
 * Rows for the target map, top layer first — the order GitHub draws a stack in,
 * and the order `pr-stack/stackModel.ts` already renders the read side in.
 *
 * In base mode the "chain" is empty and this degenerates to two rows: the new
 * pull request over its base branch. Same component, same shape, so switching
 * modes moves rows rather than swapping one widget for another.
 */
export function stackMapRows(options: {
  head: string;
  /** Open pull requests below the new one, top-first. Empty in base mode. */
  chain: PullRequest[];
  /** The branch the bottom of the chain targets. */
  trunk: string;
  /** Commits the new pull request would carry. */
  commitCount: number;
  /** Number assigned once the pull request exists, else null. */
  createdNumber: number | null;
}): StackMapRow[] {
  const { head, chain, trunk, commitCount, createdNumber } = options;
  const rows: StackMapRow[] = [
    {
      key: `new:${head}`,
      kind: STACK_ROW_KIND.New,
      layer: layerLabel(chain.length + 1, chain.length > 0),
      branch: head,
      num: createdNumber === null ? "" : `#${createdNumber}`,
      state: "New",
      meta: `${commitCount} ${commitCount === 1 ? "commit" : "commits"}`,
    },
  ];
  chain.forEach((pr, index) => {
    rows.push({
      key: `pr:${pr.num}`,
      kind: STACK_ROW_KIND.Layer,
      layer: layerLabel(chain.length - index, true),
      branch: pr.branch,
      num: `#${pr.num}`,
      state: pr.draft ? "Draft" : "Open",
      meta: pr.age,
    });
  });
  rows.push({
    key: `trunk:${trunk}`,
    kind: STACK_ROW_KIND.Trunk,
    layer: "",
    branch: trunk,
    num: "",
    state: "",
    meta: "base branch",
  });
  return rows;
}

/** "Merges bottom-up: #141, #143, then this one." — the order a stack lands in. */
export function mergeOrderNote(chain: PullRequest[]): string {
  if (chain.length === 0) return "";
  const bottomUp = [...chain].reverse().map((pr) => `#${pr.num}`);
  return `Merges bottom-up: ${bottomUp.join(", ")}, then this one.`;
}

/** Layer labels only make sense inside a stack; a lone pull request has none. */
function layerLabel(position: number, stacked: boolean): string {
  return stacked ? `L${position}` : "";
}
