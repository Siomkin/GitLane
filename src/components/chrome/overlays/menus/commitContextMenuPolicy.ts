import type { RepoForge, RepoGraph } from "@/lib/api";
import { commitWebUrl } from "@/lib/forgeUrls";
import { isCommitReachableFromRemote } from "@/store/selection";

export interface CommitContextMenuPolicyInput {
  sha: string;
  shortSha: string;
  graph: RepoGraph | null;
  forge: RepoForge | null;
  /** The current branch (`summary.headBranch`), or null when detached. */
  headBranch: string | null;
  /** The single selected commit, used for the "Compare with…" row. */
  selectedCommit: string | null;
}

export interface CommitContextMenuPolicy {
  /** The commit's subject line; falls back to the short sha when the commit
   * isn't in the loaded graph (no standalone commit-detail command exists). */
  subject: string;
  /** The commit body, empty when unknown. */
  body: string;
  /** Reword is offered only for the local-only HEAD (any-commit reword is
   * deferred to the history-rewrite ticket). */
  canRewordHead: boolean;
  /** Browser URL for this commit — non-null only when the commit is reachable
   * from a remote ref (an unpushed commit's link would 404) AND the forge has a
   * web URL. Drives both "View on <forge>" and "Copy link to commit". */
  forgeCommitUrl: string | null;
  /** Human forge label for the "View on <forge>" row (e.g. "GitHub"). */
  forgeName: string | null;
  /** Another selected commit to compare against, or null. */
  otherSelected: string | null;
}

/** Pure eligibility policy for the single-commit context menu, mirroring
 * `deriveBranchContextMenuPolicy`. Keeps the menu component declarative and the
 * gating (local-only reword, forge-link visibility) unit-testable. */
export function deriveCommitContextMenuPolicy({
  sha,
  shortSha,
  graph,
  forge,
  headBranch,
  selectedCommit,
}: CommitContextMenuPolicyInput): CommitContextMenuPolicy {
  const commit = graph?.commits.find((c) => c.id === sha && !c.stash);
  const subject = commit?.summary ?? shortSha;
  const body = commit?.body ?? "";

  const reachable = isCommitReachableFromRemote(graph, sha);
  const canRewordHead = !!headBranch && !!commit && graph?.head === sha && !reachable;

  // Only a *recognised* forge yields a real commit URL. An unknown host reports
  // `kind: null` (often still with a `webUrl`), for which `commitWebUrl` would
  // fall back to the repo root — a wrong link, so hide the affordance entirely.
  const knownForge = forge?.kind != null;
  const forgeCommitUrl = reachable && knownForge ? commitWebUrl(forge, sha) : null;
  const forgeName = forgeCommitUrl ? (forge?.forge ?? null) : null;

  const otherSelected = selectedCommit && selectedCommit !== sha ? selectedCommit : null;

  return { subject, body, canRewordHead, forgeCommitUrl, forgeName, otherSelected };
}
