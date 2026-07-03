import { useSortable } from "@dnd-kit/react/sortable";
import { cn } from "../../lib/cn";
import { repoLabel } from "../../lib/paths";
import { focusRing } from "../../lib/ui";
import { CloseIcon, FolderIcon } from "../ui/icons";

interface ProjectTabProps {
  path: string;
  index: number;
  active: boolean;
  /** True when this tab's path failed to resolve (the missing-repo state,
   * GL-108) — flagged amber like the recents list's "Missing" badge. */
  missing?: boolean;
  onSelect: () => void;
  onClose: () => void;
}

export const ProjectTab = ({
  path,
  index,
  active,
  missing = false,
  onSelect,
  onClose,
}: ProjectTabProps) => {
  const sortable = useSortable({
    id: path,
    index,
    type: "repo-tab",
    accept: "repo-tab",
  });

  return (
    <div
      ref={sortable.ref}
      data-dragging={sortable.isDragging ? "true" : undefined}
      className={cn(
        "group flex h-7 max-w-56 shrink-0 items-center gap-2 rounded-lg pl-2.5 pr-1.5 text-[13px] transition-opacity data-[dragging=true]:opacity-60",
        active
          ? "bg-white font-medium text-neutral-800 shadow-sm dark:bg-neutral-800 dark:text-neutral-100"
          : "text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5",
      )}
    >
      <div className="relative h-5 w-3.5 shrink-0">
        <FolderIcon
          className={cn(
            "absolute left-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0",
            missing ? "text-amber-500" : active ? "text-[color:var(--accent)]" : "text-neutral-400",
          )}
        />
        <button
          ref={sortable.handleRef}
          type="button"
          className={cn(
            "pointer-events-none absolute left-1/2 top-1/2 grid h-5 w-5 -translate-x-1/2 -translate-y-1/2 cursor-grab place-items-center rounded text-neutral-300 opacity-0 transition-opacity active:cursor-grabbing hover:bg-black/5 hover:text-neutral-500 focus:pointer-events-auto focus:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 dark:text-neutral-600 dark:hover:bg-white/10 dark:hover:text-neutral-300",
            focusRing,
          )}
          title="Drag to reorder repository"
          aria-label={`Drag ${repoLabel(path)} to reorder`}
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
        <span className="truncate">{repoLabel(path)}</span>
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
        aria-label={`Close ${repoLabel(path)}`}
      >
        <CloseIcon className="h-2.5 w-2.5" />
      </button>
    </div>
  );
};
