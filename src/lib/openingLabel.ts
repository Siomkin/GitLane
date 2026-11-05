// What a pending repository open is doing, in words (tab-open-progress): one
// helper so the tab tooltip and the workspace overlay never disagree.

import type { RemoteSessionEvent } from "@/lib/api";

/**
 * `name` is the tab's display name; `host` the SSH host (or saved connection
 * name) for a remote repository, null for a local one; `session` that host's
 * latest session event, if any.
 */
export function openingLabel(
  name: string,
  host: string | null,
  session?: Pick<RemoteSessionEvent, "state" | "progress">,
): string {
  if (host && session?.state === "connecting") return `Connecting to ${host}…`;
  if (host && session?.state === "installing") {
    const progress = session.progress;
    return progress
      ? `Installing GitLane agent — ${progress.stage} ${Math.round(progress.percent)}%`
      : `Installing GitLane agent on ${host}…`;
  }
  // A session that still reads `connected` may be waiting out a connection that
  // died during sleep, so a remote open always names its host.
  return host ? `Opening ${name} on ${host}…` : `Opening ${name}…`;
}
