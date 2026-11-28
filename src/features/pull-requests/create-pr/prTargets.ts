// Pure target model for the create-PR form: what a new pull request can be
// opened against, and the stack it would join. No React, no IPC.
//
// A stack is structural, not an opt-in: GitHub's bottom pull request targets
// the trunk, and "each subsequent pull request targets the branch of the pull
// request below it". All branches must be in one repository — cross-fork stacks
// are not supported. GitLane already reads and merges those (`pr-stack/`); this
// module is the create side, and borrows GitHub's own vocabulary — layer,
// bottom, top, trunk.

import { BranchKind, type BranchInfo, type RemoteInfo } from "@/lib/api";
import {
  remoteNamesOf,
  remoteOfBranch,
  resolveDefaultPublishTarget,
  shouldPublishNamesake,
} from "@/lib/branchSync";
import { PR_STATE, type PrSummary } from "@/lib/prs";
import { remoteNameForUpstream } from "@/lib/remoteAccounts";
import { shortName } from "@/lib/remoteBranches";

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
  pr: PrSummary;
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
 * Merged and closed pull requests are filtered out here, not by the caller: the
 * list this draws from is `gh pr list --state all`, so a long-merged branch is
 * still an ancestor of everything cut after it. Targeting one would open a pull
 * request against a head nobody will merge, whose branch is often deleted.
 *
 * The pull request whose head *is* the current branch is left out too — it is
 * already open, and nothing stacks on itself.
 */
export function stackCandidates(
  prs: PrSummary[],
  remote: string | null,
  head: string,
): Map<string, PrSummary> {
  const byRef = new Map<string, PrSummary>();
  if (!remote) return byRef;
  for (const pr of prs) {
    if (pr.state === PR_STATE.Open && pr.branch !== head) byRef.set(`${remote}/${pr.branch}`, pr);
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
  byRef: Map<string, PrSummary>,
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
export function stackChain(parent: PrSummary, prs: PrSummary[]): PrSummary[] {
  const chain: PrSummary[] = [parent];
  const seen = new Set<number>([parent.num]);
  const open = prs.filter((pr) => pr.state === PR_STATE.Open);
  for (;;) {
    const below = open.find((pr) => pr.branch === chain[chain.length - 1].base);
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
  chain: PrSummary[];
  /** The branch the bottom of the chain targets. */
  trunk: string;
  /** Commits the new pull request would carry, or null when the range read
   * failed — a count is an answer, and "0 commits" is the wrong one. */
  commitCount: number | null;
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
      meta:
        commitCount === null
          ? "commits"
          : `${commitCount} ${commitCount === 1 ? "commit" : "commits"}`,
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
export function mergeOrderNote(chain: PrSummary[]): string {
  if (chain.length === 0) return "";
  const bottomUp = [...chain].reverse().map((pr) => `#${pr.num}`);
  return `Merges bottom-up: ${bottomUp.join(", ")}, then this one.`;
}

export interface PrPublishPlan {
  /** `remote/branch` to publish before creating the PR, or null if none. */
  publishTarget: string | null;
  /** Explicit remote for `publish_branch`, so an unfetched slashed remote
   * (e.g. `origin/feat`) cannot hijack `origin/feat/topic`. */
  publishRemote: string | null;
  /** Inline explanation when the head branch cannot be published/submitted as
   * a same-repository pull request on the resolved PR repository. */
  crossRepoError: string | null;
  /** True while forge detection is still pending and the head branch needs
   * publishing — submission stays disabled until the PR repository is verified. */
  awaitingForge: boolean;
}

const NO_MATCHING_PR_REMOTE =
  "Cross-repository pull requests are not supported — no configured remote pushes to the resolved pull request repository.";

const mismatchedPrRemoteError = (head: string, prRemote: string) =>
  `Cross-repository pull requests are not supported — push ${head} to ${prRemote} or change the pull request repository.`;

/** Decide whether opening a PR for `head` should auto-publish it first, and
 * verify that the head branch's destination matches the PR's resolved target
 * repository (`prRemote`). GitLane submits bare `--head <branch>` names, so
 * cross-repository heads are blocked with an inline explanation, and pending
 * forge detection holds submission until the target repository is known. */
export function resolvePrPublishPlan(options: {
  head: string;
  headInfo: BranchInfo | undefined;
  branches: BranchInfo[];
  remotes: readonly Pick<RemoteInfo, "name">[];
  forgeResolved: boolean;
  prRemote: string | null | undefined;
  prRemotes?: readonly string[] | undefined;
}): PrPublishPlan {
  const { head, headInfo, branches, remotes, forgeResolved, prRemote, prRemotes } = options;
  const noPublish = {
    publishTarget: null,
    publishRemote: null,
    crossRepoError: null,
    awaitingForge: false,
  };
  if (!head || !headInfo) return noPublish;

  const { upstream, upstreamRemote, pushRemote } = headInfo;
  const needsPublish = !upstream || shouldPublishNamesake(headInfo, branches);
  if (needsPublish && !forgeResolved) return { ...noPublish, awaitingForge: true };

  const allowedPrRemotes =
    prRemotes && prRemotes.length > 0
      ? prRemotes
      : prRemote
        ? [prRemote]
        : [];
  const prRemoteKnown = prRemote !== undefined || prRemotes !== undefined;
  const primaryPrRemote = prRemote ?? allowedPrRemotes[0] ?? null;
  if (prRemote === null || (prRemotes !== undefined && allowedPrRemotes.length === 0)) {
    return { ...noPublish, crossRepoError: NO_MATCHING_PR_REMOTE };
  }

  const allRemoteNames = [...new Set([...remotes.map((r) => r.name), ...remoteNamesOf(branches)])];
  if (needsPublish) {
    const { target: fallback, remote: fallbackRemote } = resolveDefaultPublishTarget(
      branches,
      head,
      upstream,
      false,
      upstreamRemote,
    );
    // Older agents use "origin" even when no push remote was configured.
    const legacyOrigin = pushRemote === "origin" &&
      allRemoteNames.length > 0 && !allRemoteNames.includes("origin");
    const configuredRemote = upstream
      ? (!upstreamRemote || upstreamRemote === "." ? fallbackRemote : upstreamRemote)
      : (pushRemote && pushRemote !== "." && !legacyOrigin ? pushRemote : null);
    if (
      prRemoteKnown &&
      primaryPrRemote &&
      (upstream || configuredRemote) &&
      (!configuredRemote || !allowedPrRemotes.includes(configuredRemote))
    ) {
      return { ...noPublish, crossRepoError: mismatchedPrRemoteError(head, primaryPrRemote) };
    }

    const publishRemote =
      configuredRemote && allowedPrRemotes.includes(configuredRemote)
        ? configuredRemote
        : primaryPrRemote ?? (upstream ? configuredRemote : null);
    return {
      ...noPublish,
      publishTarget: publishRemote ? `${publishRemote}/${head}` : fallback,
      publishRemote: publishRemote ?? fallbackRemote,
    };
  }

  const effectiveRemote = pushRemote ?? upstreamRemote ??
    (upstream ? remoteNameForUpstream(upstream, allRemoteNames) : null);
  if (
    prRemoteKnown &&
    primaryPrRemote &&
    effectiveRemote &&
    effectiveRemote !== "." &&
    !allowedPrRemotes.includes(effectiveRemote)
  ) {
    const existsOnPrRemote = branches.some(
      (branch) =>
        branch.kind === BranchKind.Remote &&
        allowedPrRemotes.includes(remoteOfBranch(branch, allRemoteNames) ?? "") &&
        shortName(branch) === head,
    );
    if (!existsOnPrRemote) {
      return { ...noPublish, crossRepoError: mismatchedPrRemoteError(head, primaryPrRemote) };
    }
  }

  return noPublish;
}
