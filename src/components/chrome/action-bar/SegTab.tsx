import { cn } from "../../../lib/cn";
import { focusRing } from "../../../lib/ui";
import type { ReactNode } from "react";

/** A tab in the Commits/PRs segmented control — the toolbar's 32px height
 * reference. Shows an icon, label, and an optional count badge. */
export const SegTab = ({
  active,
  onClick,
  icon,
  label,
  badge,
  badgeTone,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  badge?: number;
  badgeTone: "accent" | "purple";
}) => {
  return (
    <button type="button"
      className={cn(
        "flex h-full items-center gap-1.5 rounded-md px-3 font-medium transition",
        focusRing,
        active
          ? "bg-white text-neutral-800 shadow-sm dark:bg-neutral-700 dark:text-neutral-100"
          : "text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200",
      )}
      onClick={onClick}
    >
      {icon}
      {label}
      {badge !== undefined && (
        <span
          className={cn(
            "grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[10px] font-semibold text-white",
            badgeTone === "accent" ? "bg-[var(--accent)]" : "bg-purple-500",
          )}
        >
          {badge}
        </span>
      )}
    </button>
  );
};
