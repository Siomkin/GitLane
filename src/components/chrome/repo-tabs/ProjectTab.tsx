import { cn } from "@/lib/cn";
import { repoLabel } from "@/lib/paths";
import type { TabDisplay } from "@/lib/tabs";
import { focusRing } from "@/lib/ui";
import { CloseIcon, FolderIcon, TreeIcon } from "@/components/ui/icons";

interface ProjectTabProps {
  path: string;
  active: boolean;
  /** The sortable this tab is the drag surface of — its own (a tab inside a
   * group) or its run's (a lone ungrouped tab, which drags as a run). The tab
   * never owns a sortable itself, so a tab can't be dragged out of a group and
   * re-parented mid-drag (GL — repo groups). */
  drag: {
    ref: (element: Element | null) => void;
    handleRef: (element: Element | null) => void;
    dragging: boolean;
  };
  /** True when this tab's path failed to resolve (the missing-repo state,
   * GL-108) — flagged amber like the recents list's "Missing" badge. */
  missing?: boolean;
  /** How the tab presents itself: a plain repo tab, or a worktree tab showing
   * `parent repo · branch` with the accent tree icon (GL-110). Defaults to a
   * plain repo tab labeled by the path's leaf directory. */
  display?: TabDisplay;
  onSelect: () => void;
  onClose: () => void;
  /** Right-click anywhere on the tab: raises the repo-tab menu (rename, group)
   * at the pointer. */
  onContextMenu: (x: number, y: number) => void;
}

export const ProjectTab = ({
  path,
  active,
  missing = false,
  display,
  onSelect,
  onClose,
  onContextMenu,
  drag,
}: ProjectTabProps) => {
  const shown: TabDisplay = display ?? { kind: "repo", name: repoLabel(path) };
  const label =
    shown.kind === "worktree" ? `${shown.repoName} · ${shown.detail}` : shown.name;

  return (
    <div
      ref={drag.ref}
      data-dragging={drag.dragging ? "true" : undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      className={cn(
        "group flex h-7 max-w-56 shrink-0 items-center gap-2 rounded-lg pl-2.5 pr-1.5 text-[13px] transition-opacity data-[dragging=true]:opacity-60",
        active
          ? "bg-white font-medium text-neutral-800 ring-1 ring-inset ring-black/[0.05] dark:bg-neutral-800 dark:text-neutral-100 dark:ring-white/[0.06]"
          : "text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5",
      )}
    >
      <div className="relative h-5 w-3.5 shrink-0">
        {shown.kind === "worktree" && !missing ? (
          // The accent tree icon is the worktree signal — the same visual
          // language as the toolbar worktree indicator (GL-22). A missing
          // worktree falls back to the amber folder below: gone-ness beats
          // worktree-ness (the recovery screen is what the tab opens onto).
          <TreeIcon
            className={cn(
              "absolute left-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[color:var(--accent)] transition-opacity group-hover:opacity-0 group-focus-within:opacity-0",
              !active && "opacity-60",
            )}
          />
        ) : (
          <FolderIcon
            className={cn(
              "absolute left-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0",
              missing ? "text-amber-500" : active ? "text-[color:var(--accent)]" : "text-neutral-400",
            )}
          />
        )}
        <button
          ref={drag.handleRef}
          type="button"
          className={cn(
            "pointer-events-none absolute left-1/2 top-1/2 grid h-5 w-5 -translate-x-1/2 -translate-y-1/2 cursor-grab place-items-center rounded text-neutral-300 opacity-0 transition-opacity active:cursor-grabbing hover:bg-black/5 hover:text-neutral-500 focus:pointer-events-auto focus:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 dark:text-neutral-600 dark:hover:bg-white/10 dark:hover:text-neutral-300",
            focusRing,
          )}
          title="Drag to reorder repository"
          aria-label={`Drag ${label} to reorder`}
        >
          <span aria-hidden="true" className="grid grid-cols-2 gap-[2px]">
            <span className="h-0.5 w-0.5 rounded-full bg-current" />
            <span className="h-0.5 w-0.5 rounded-full bg-current" />
            <span className="h-0.5 w-0.5 rounded-full bg-current" />
            <span className="h-0.5 w-0.5 rounded-full bg-current" />
            <span className="h-0.5 w-0.5 rounded-full bg-current" />
            <span className="h-0.5 w-0.5 rounded-full bg-current" />
          </span>
        </button>
      </div>
      <button
        type="button"
        className={cn("flex min-w-0 items-center text-left", focusRing)}
        onClick={onSelect}
        title={path}
      >
        {shown.kind === "worktree" ? (
          <>
            {/* The branch is the distinguishing part; the parent repo name
                (repeated from the main tab it groups next to) stays muted. */}
            <span className="max-w-24 shrink-0 truncate text-neutral-400 dark:text-neutral-500">
              {shown.repoName}
            </span>
            <span aria-hidden="true" className="mx-1 shrink-0 text-neutral-400 dark:text-neutral-500">
              ·
            </span>
            <span className="truncate">{shown.detail}</span>
          </>
        ) : (
          <span className="truncate">{shown.name}</span>
        )}
      </button>
      <button
        type="button"
        className={cn(
          "grid h-4 w-4 shrink-0 place-items-center rounded text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10",
          focusRing,
        )}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        title="Close repository"
        aria-label={`Close ${label}`}
      >
        <CloseIcon className="block h-2.5 w-2.5" />
      </button>
    </div>
  );
};
