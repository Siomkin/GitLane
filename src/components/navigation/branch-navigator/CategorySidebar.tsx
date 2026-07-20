import type { ComponentType, SVGProps } from "react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import {
  BranchIcon,
  CloudIcon,
  ListIcon,
  StashIcon,
  TagIcon,
  TreeIcon,
} from "@/components/ui/icons";
import { NavCategory } from "./refs";

interface CategoryDef {
  key: NavCategory;
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
}

/** Sidebar order mirrors the design (All first, then ref kinds); Stashes is a
 * GitLane addition the mockup doesn't carry. */
const CATEGORIES: CategoryDef[] = [
  { key: NavCategory.All, label: "All", Icon: ListIcon },
  { key: NavCategory.Branches, label: "Branches", Icon: BranchIcon },
  { key: NavCategory.Remotes, label: "Remotes", Icon: CloudIcon },
  { key: NavCategory.Worktrees, label: "Worktrees", Icon: TreeIcon },
  { key: NavCategory.Tags, label: "Tags", Icon: TagIcon },
  { key: NavCategory.Stashes, label: "Stashes", Icon: StashIcon },
];

/** The navigator's left rail: one row per category with its total count. The
 * active category gets the accent-soft treatment; picking one clears the
 * search (per the design) via the container's `onSelect`. */
export function CategorySidebar({
  active,
  counts,
  onSelect,
}: {
  active: NavCategory;
  counts: Record<NavCategory, number>;
  onSelect: (category: NavCategory) => void;
}) {
  return (
    <div className="w-[152px] shrink-0 space-y-0.5 border-r border-black/5 bg-black/[0.015] p-1.5 dark:border-white/5 dark:bg-white/[0.02]">
      {CATEGORIES.map(({ key, label, Icon }) => {
        const isActive = key === active;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={isActive}
            onClick={() => onSelect(key)}
            className={cn(
              "flex h-7 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-[12.5px]",
              focusRing,
              isActive
                ? "bg-[var(--accent-soft)] font-medium text-[color:var(--accent)]"
                : "text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5",
            )}
          >
            <Icon className={cn("h-4 w-4 shrink-0", !isActive && "text-neutral-400")} />
            <span className="truncate">{label}</span>
            <span className={cn("ml-auto text-[11px]", isActive ? "opacity-70" : "text-neutral-400")}>
              {counts[key]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
