// Pure derivations for the toolbar (GL-182): branch trigger label, the
// current-branch PR badge match, transport-auth visibility, and the PR-forge
// gate for badge polling. Framework-free — `useActionBarModel` calls these
// per render (they are cheap); tests drive them directly.

import { headStateOf, type ForgeKind, type RemoteInfo, type RepoSummary } from "@/lib/api";
import { supportsCreatingPullRequests, supportsPullRequests } from "@/lib/forgeHelp";
import { detectRemoteUrl } from "@/lib/remotes";
import type { PrSummary } from "@/lib/prs";

/** The branch trigger's label: detached SHA, unborn placeholder, or the branch. */
export function currentBranchLabel(summary: RepoSummary | null): string {
  const head = headStateOf(summary);
  switch (head.kind) {
    case "detached":
      return `detached @ ${head.oid.slice(0, 7) || "?"}`;
    case "unborn":
      return "No commits yet";
    case "branch":
      return head.branch;
    case "none":
      return "No branch";
  }
}

/** Open PR whose head is the checked-out branch — surfaced as a clickable
 * badge. An unborn branch has no pushed commits, so it can't own a PR even if
 * one happens to share its name (e.g. the default `main`); skip the match. */
export function findOpenPr(
  summary: RepoSummary | null,
  pullRequests: PrSummary[],
): PrSummary | undefined {
  const head = headStateOf(summary);
  if (head.kind !== "branch") return undefined;
  return pullRequests.find((pr) => pr.state === "open" && pr.branch === head.branch);
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

/** PRs are supported on GitHub, GitLab (GL-140), Bitbucket (GL-141), and Cursor
 * Origin; the store's gate handles the account/transport resolution per forge. */
export function isPrForge(kind: ForgeKind | null | undefined): boolean {
  return supportsPullRequests(kind ?? undefined);
}

/** Create is GitHub, GitLab, Bitbucket, and Cursor Origin; Azure DevOps is
 * list-only. */
export function canCreatePullRequest(kind: ForgeKind | null | undefined): boolean {
  return supportsCreatingPullRequests(kind ?? undefined);
}
