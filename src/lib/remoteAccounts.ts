// Which remote a push targets — pure mirrors of the backend's own resolution
// (write/remotes.rs `push_target` / `split_remote_ref`), so the frontend picks
// the per-remote account (GL-129) for the same remote git will actually push
// to. No React, no IPC.

import type { BranchInfo } from "./api";

/** The remote half of an `upstream` (`remote/branch`) string, resolved by
 * longest-prefix match against the configured remote names — a remote name may
 * itself contain a slash, and a first-`/` split would pick the wrong account.
 * Falls back to the first-`/` segment when nothing matches (a first push to a
 * not-yet-listed remote); null when there is no `/` at all. */
export function remoteNameForUpstream(upstream: string, remoteNames: string[]): string | null {
  const matched = remoteNames
    .filter((name) => upstream.startsWith(`${name}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (matched) return matched;
  const slash = upstream.indexOf("/");
  return slash > 0 ? upstream.slice(0, slash) : null;
}

/** The remote a push of this local branch targets: its configured
 * `branch.<name>.remote` (shipped as `upstreamRemote`), falling back to
 * "origin" — the backend's `push_target` fallback. */
export function pushRemoteForBranch(
  branch: Pick<BranchInfo, "upstreamRemote"> | undefined,
): string {
  return branch?.upstreamRemote ?? "origin";
}
