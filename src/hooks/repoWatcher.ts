// The `repo-changed` event's name, payload type and schema live at the IPC seam
// (`lib/api/events.ts`, mirrored by `src-tauri/src/events.rs`); this module owns
// only what the watcher hook does with one — how a change kind collapses into a
// refresh scope.
import type { RepoChangeKind } from "@/lib/api";

export type RefreshScope = "worktree" | "all";

/** Graph work dominates worktree-only refreshes inside one debounce window. */
export function mergeRefreshScope(
  current: RefreshScope | null,
  kind: RepoChangeKind,
): RefreshScope {
  if (current === "all" || kind === "graph") return "all";
  return "worktree";
}
