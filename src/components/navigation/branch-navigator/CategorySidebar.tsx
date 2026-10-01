import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { NAV_CATEGORIES, type NavCategory } from "./refs";

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
      {NAV_CATEGORIES.map(({ key, label, Icon }) => {
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
