// Pure target model for the create-PR form: what a new pull request can be
// opened against, and the stack it would join. No React, no IPC.
//
// A stack is structural, not an opt-in: GitHub's bottom pull request targets
// the trunk, and "each subsequent pull request targets the branch of the pull
// request below it". All branches must be in one repository — cross-fork stacks
// are not supported. GitLane already reads and merges those (`pr-stack/`); this
// module is the create side, and borrows GitHub's own vocabulary — layer,
// bottom, top, trunk.

import type { PullRequest } from "@/lib/prs";

/** How a row in the target map is drawn. */
export const STACK_ROW_KIND = {
  /** The pull request being composed — always the top layer. */
  New: "new",
  /** An existing open pull request in the chain below. */
  Layer: "layer",
  /** The branch the bottom layer targets. Not itself a pull request. */
  Trunk: "trunk",
} as const;
export type StackRowKind = (typeof STACK_ROW_KIND)[keyof typeof STACK_ROW_KIND];

export interface StackMapRow {
  key: string;
  kind: StackRowKind;
  /** "L3", "L2"… counted from the trunk. Empty outside a stack. */
  layer: string;
  branch: string;
  /** "#143", or empty before the new pull request has a number. */
  num: string;
  /** True for a layer still in draft — the pill reads Draft rather than Open. */
  isDraft: boolean;
  /** Right-aligned detail: commit count for the new row, age for a layer. */
  meta: string;
}

export interface StackParent {
  pr: PullRequest;
  /** The ref that actually resolved. Local reads must use this; the forge is
   * told `pr.branch`, since a pull request targets a branch, not a ref. */
  ref: string;
}

/**
 * The refs to ask the ancestor probe about, mapped back to the pull request
 * each one belongs to.
 *
 * Remote-tracking refs only: an open pull request's head is by definition
 * pushed, so the tracking ref is the accurate comparison. A same-named local
 * branch could have drifted from what the pull request actually contains.
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
  if (!remote) return byRef;
  for (const pr of openPrs) {
    if (pr.branch !== head) byRef.set(`${remote}/${pr.branch}`, pr);
  }
  return byRef;
}

/**
 * The nearest open pull request the head branch could stack on.
 *
 * `ancestors` arrives nearest-first from the backend, so the first one that
 * maps to an open pull request is the layer this work was cut from. Null when
 * nothing matches — the ordinary "target a branch" case, not an error.
 *
 * Only open pull requests are ever in `byRef`: a merged or closed one may still
 * be an ancestor, but targeting it would open a pull request against a base
 * nobody is going to merge.
 */
export function stackParent(
  ancestors: string[],
  byRef: Map<string, PullRequest>,
): StackParent | null {
  for (const ref of ancestors) {
    const pr = byRef.get(ref);
    if (pr) return { pr, ref };
  }
  return null;
}

/**
 * The chain below `parent`, bottom layer last.
 *
 * Walks base -> head links through the open pull requests. Stops at the first
 * base that is not another open pull request's head — that base is the trunk.
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

/**
 * Rows for the target map, top layer first — the order GitHub draws a stack in,
 * and the order `pr-stack/stackModel.ts` already renders the read side in.
 *
 * In base mode the chain is empty and this degenerates to two rows: the new
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
  const stacked = chain.length > 0;
  const layer = (position: number) => (stacked ? `L${position}` : "");
  return [
    {
      key: `new:${head}`,
      kind: STACK_ROW_KIND.New,
      layer: layer(chain.length + 1),
      branch: head,
      num: createdNumber === null ? "" : `#${createdNumber}`,
      isDraft: false,
      meta: `${commitCount} ${commitCount === 1 ? "commit" : "commits"}`,
    },
    ...chain.map((pr, index) => ({
      key: `pr:${pr.num}`,
      kind: STACK_ROW_KIND.Layer,
      layer: layer(chain.length - index),
      branch: pr.branch,
      num: `#${pr.num}`,
      isDraft: pr.draft,
      meta: pr.age,
    })),
    {
      key: `trunk:${trunk}`,
      kind: STACK_ROW_KIND.Trunk,
      layer: "",
      branch: trunk,
      num: "",
      isDraft: false,
      meta: "base branch",
    },
  ];
}

/** "Merges bottom-up: #141, #143, then this one." — the order a stack lands in. */
export function mergeOrderNote(chain: PullRequest[]): string {
  if (chain.length === 0) return "";
  const bottomUp = [...chain].reverse().map((pr) => `#${pr.num}`);
  return `Merges bottom-up: ${bottomUp.join(", ")}, then this one.`;
}
