// Pure decision model for the graph's ref pills (GL-191): which glyph a pill
// shows, which tone classes it wears, whether/how it drags, and its tooltip.
// Extracted from RefPill/CombinedRefPill so the visual policy is testable as a
// matrix without a render — the leaves keep the SVGs and the store wiring
// (useBranchWorktreeName stays a hook; its result feeds `worktreeName` here).
// No React, no IPC.
import type { RefLabel } from "../../../lib/api";
import type { BranchRefKind } from "../../../lib/graphActions";

/** Glyph discriminant — the components map these to the actual SVGs. */
export type RefPillIcon = "current" | "tag" | "remote" | "worktree" | "branch";

export interface RefPillModel {
  /** Branch and remote-tracking refs drag; tags don't. */
  draggable: boolean;
  /** The drag payload kind when draggable (local branch vs remote ref). */
  dragKind: BranchRefKind | null;
  icon: RefPillIcon;
  /** The pill's full class string (base + tone variant). */
  className: string;
  /** Worktree tooltip, only when the branch lives in another worktree. */
  title: string | undefined;
}

const PILL_BASE =
  "flex items-center gap-1 h-[22px] rounded-md text-[11px] font-medium whitespace-nowrap shrink-0 select-none max-w-[220px]";

/** Tone precedence mirrors the render: current wins, then tag, remote, local. */
export function refPillModel(refLabel: RefLabel, current: boolean, worktreeName: string | null): RefPillModel {
  const draggable = refLabel.kind === "branch" || refLabel.kind === "remote";

  const style = current
    ? "pl-1 pr-2 bg-[var(--accent)] text-white shadow-sm cursor-grab active:cursor-grabbing"
    : refLabel.kind === "tag"
      ? "pl-1.5 pr-2 bg-amber-50 dark:bg-amber-400/10 border border-amber-300/70 dark:border-amber-400/25 text-amber-700 dark:text-amber-300"
      : refLabel.kind === "remote"
        ? "pl-1.5 pr-2 bg-black/[0.04] dark:bg-white/[0.05] border border-black/[0.06] dark:border-white/[0.06] text-neutral-500 dark:text-neutral-400 cursor-grab active:cursor-grabbing"
        : "pl-1.5 pr-2 bg-white dark:bg-neutral-700 border border-black/10 dark:border-white/10 text-neutral-700 dark:text-neutral-200 shadow-sm cursor-grab active:cursor-grabbing";

  // Icon precedence mirrors the render: current, tag, remote, then the
  // worktree glyph for a branch living in another checkout, else the fork.
  const icon: RefPillIcon = current
    ? "current"
    : refLabel.kind === "tag"
      ? "tag"
      : refLabel.kind === "remote"
        ? "remote"
        : worktreeName
          ? "worktree"
          : "branch";

  return {
    draggable,
    dragKind: draggable ? (refLabel.kind === "branch" ? "local" : "remote") : null,
    icon,
    className: `${PILL_BASE} ${style}`,
    title: worktreeName ? `Checked out in worktree: ${worktreeName}` : undefined,
  };
}

export interface CombinedRefPillModel {
  /** Collapsed grouped pills never show tag/remote glyphs. */
  icon: Extract<RefPillIcon, "current" | "worktree" | "branch">;
  className: string;
  /** The trailing remote-count chip's accessible label, e.g. "2 remotes". */
  remoteLabel: string;
  title: string;
}

const COMBINED_BASE =
  "flex items-center gap-1 h-[22px] rounded-md text-[11px] font-medium whitespace-nowrap shrink-0 select-none max-w-[240px] cursor-grab active:cursor-grabbing";

/** The collapsed local+remote(s) pill: acts as the local branch, so its glyph
 * follows the local branch's state (current / other-worktree / plain). */
export function combinedRefPillModel(
  localName: string,
  remoteCount: number,
  current: boolean,
  worktreeName: string | null,
): CombinedRefPillModel {
  const style = current
    ? "pl-1 pr-1 bg-[var(--accent)] text-white shadow-sm"
    : "pl-1.5 pr-1 bg-white dark:bg-neutral-700 border border-black/10 dark:border-white/10 text-neutral-700 dark:text-neutral-200 shadow-sm";
  const remoteLabel = `${remoteCount} remote${remoteCount > 1 ? "s" : ""}`;
  return {
    icon: current ? "current" : worktreeName ? "worktree" : "branch",
    className: `${COMBINED_BASE} ${style}`,
    remoteLabel,
    title: `${localName} — local + ${remoteLabel} in sync (click to split)`,
  };
}
