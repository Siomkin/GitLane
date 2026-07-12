// Pure derivations for the toolbar (GL-182): branch trigger label, the
// current-branch PR badge match, transport-auth visibility, and the PR-forge
// gate for badge polling. Framework-free — `useActionBarModel` calls these
// per render (they are cheap); tests drive them directly.

import { ForgeKind, type RemoteInfo, type RepoSummary } from "@/lib/api";
import { detectRemoteUrl } from "@/lib/remotes";
import type { PullRequest } from "@/lib/prs";

/** The branch trigger's label: detached SHA, unborn placeholder, or the branch. */
export function currentBranchLabel(summary: RepoSummary | null): string {
  if (summary?.detached) return `detached @ ${summary.headOid?.slice(0, 7) ?? "?"}`;
  if (summary?.unborn) return "No commits yet";
  return summary?.headBranch ?? "No branch";
}

/** Open PR whose head is the checked-out branch — surfaced as a clickable
 * badge. An unborn branch has no pushed commits, so it can't own a PR even if
 * one happens to share its name (e.g. the default `main`); skip the match. */
export function findOpenPr(
  summary: RepoSummary | null,
  pullRequests: PullRequest[],
): PullRequest | undefined {
  if (!summary || summary.detached || summary.unborn) return undefined;
  return pullRequests.find((pr) => pr.state === "open" && pr.branch === summary.headBranch);
}

/** Match the Remotes settings card: only explicit SSH remotes or HTTPS
 * usernames count as visible transport auth. A bare HTTPS URL may still work
 * through a helper, but GitLane cannot prove that from the URL alone. */
export function transportConfigured(remotes: RemoteInfo[]): boolean {
  const defaultRemote = remotes.find((remote) => remote.isDefault) ?? remotes[0] ?? null;
  if (!defaultRemote) return false;
  const auth = detectRemoteUrl(defaultRemote.pushUrl || defaultRemote.fetchUrl);
  return Boolean(auth?.ssh || auth?.user);
}

/** PRs are supported on GitHub, GitLab (GL-140), and Bitbucket (GL-141); the
 * store's gate handles the account/transport resolution per forge. */
export function isPrForge(kind: ForgeKind | null | undefined): boolean {
  return kind === ForgeKind.GitHub || kind === ForgeKind.GitLab || kind === ForgeKind.Bitbucket;
}
