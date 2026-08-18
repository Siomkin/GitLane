// Best-effort browser URLs for refs on the repo's detected forge. Path shapes
// differ per forge; an unknown/unset forge falls back to the repo root so a
// "View on <forge>" affordance always lands somewhere sensible (or is hidden
// entirely when there's no web URL at all).

import { ForgeKind, type RepoForge } from "./api";

/** Browser URL for `branch` on `forge`, or null when the forge has no web URL. */
export function branchWebUrl(forge: RepoForge | null | undefined, branch: string): string | null {
  const base = forge?.webUrl;
  if (!base) return null;
  const root = base.replace(/\/+$/, "");
  // Preserve `/` in hierarchical branch names (feature/x) while escaping the
  // rest of each segment.
  const ref = branch.split("/").map(encodeURIComponent).join("/");
  switch (forge?.kind) {
    case ForgeKind.GitHub:
    case ForgeKind.Gitea:
    case ForgeKind.Forgejo:
    case ForgeKind.CursorOrigin:
      return `${root}/tree/${ref}`;
    case ForgeKind.GitLab:
      return `${root}/-/tree/${ref}`;
    case ForgeKind.Bitbucket:
      return `${root}/branch/${ref}`;
    case ForgeKind.AzureDevOps:
      return `${root}?version=GB${ref}`;
    default:
      return root;
  }
}

/** Browser URL for commit `sha` on `forge`, or null when the forge has no web
 * URL. The caller gates this on the commit being reachable from a remote ref —
 * an unpushed commit's link would 404. */
export function commitWebUrl(forge: RepoForge | null | undefined, sha: string): string | null {
  const base = forge?.webUrl;
  if (!base) return null;
  const root = base.replace(/\/+$/, "");
  switch (forge?.kind) {
    case ForgeKind.GitLab:
      return `${root}/-/commit/${sha}`;
    case ForgeKind.Bitbucket:
      return `${root}/commits/${sha}`;
    case ForgeKind.GitHub:
    case ForgeKind.Gitea:
    case ForgeKind.Forgejo:
    case ForgeKind.AzureDevOps:
    case ForgeKind.CursorOrigin:
      return `${root}/commit/${sha}`;
    default:
      return root;
  }
}
