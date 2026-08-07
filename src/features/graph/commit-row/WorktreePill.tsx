import { useUi, MenuKind } from "@/store/ui";
import { TreeIcon } from "@/components/ui/icons";
import type { DetachedWorktreeAt } from "./useDetachedWorktrees";
import { WorktreeDirtyDot } from "./WorktreeDirtyDot";

/** Marker for a detached worktree parked on this commit — the only visual trace
 * such a checkout leaves in the graph (it has no branch, so no ref pill).
 * Dashed border to read as "a place, not a ref": it isn't draggable and has no
 * checkout action. Right-click opens the worktree menu (open / copy path /
 * remove), mirroring the navigator row; a plain click falls through and selects
 * the commit row like empty row space would. */
export function WorktreePill({ wt }: { wt: DetachedWorktreeAt }) {
  const openMenu = useUi((s) => s.openMenu);
  return (
    <span
      className="flex h-[22px] max-w-[220px] shrink-0 select-none items-center gap-1 whitespace-nowrap rounded-md border border-dashed border-black/20 bg-black/[0.04] pl-1.5 pr-2 text-[11px] font-medium text-neutral-500 dark:border-white/20 dark:bg-white/[0.05] dark:text-neutral-400"
      title={`Worktree (detached): ${wt.path}${wt.dirty ? " — uncommitted changes" : ""}`}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu({ kind: MenuKind.Worktree, state: { x: e.clientX, y: e.clientY, path: wt.path, name: wt.name, isMain: wt.isMain } });
      }}
    >
      <TreeIcon className="h-3 w-3 shrink-0 text-neutral-400" />
      <span className="truncate">{wt.name}</span>
      {wt.dirty && <WorktreeDirtyDot />}
    </span>
  );
}
