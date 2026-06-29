// The shared selectable card used for the Default-identity row and every git
// profile row in the Identity panel's Zone A. Behaves as an ARIA radio: click
// or Space/Enter selects it. A trailing `action` (e.g. Edit) stops propagation
// so it doesn't also toggle selection.

import type { ReactNode, KeyboardEvent } from "react";
import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";

export function RadioCard({
  selected,
  onSelect,
  avatar,
  title,
  badges,
  subtitle,
  action,
  label,
}: {
  selected: boolean;
  onSelect: () => void;
  avatar: ReactNode;
  title: ReactNode;
  badges?: ReactNode;
  subtitle: ReactNode;
  action?: ReactNode;
  /** Accessible name for the radio (the cards carry mixed-element titles). */
  label: string;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      onSelect();
    }
  };
  return (
    <div
      role="radio"
      aria-checked={selected}
      aria-label={label}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      className={cn(
        "flex items-center gap-3 p-3 rounded-xl border transition-colors cursor-pointer",
        selected
          ? "bg-[var(--accent-soft)] border-[color:var(--accent)]/40"
          : "bg-black/[0.02] dark:bg-white/[0.03] border-black/10 dark:border-white/10 hover:bg-black/[0.04] dark:hover:bg-white/[0.05]",
        focusRing,
      )}
    >
      <span
        className={cn(
          "shrink-0 w-[18px] h-[18px] rounded-full grid place-items-center border-2 transition-colors",
          selected ? "border-[var(--accent)] bg-[var(--accent)]" : "border-black/20 dark:border-white/25",
        )}
      >
        {selected && <span className="w-2 h-2 rounded-full bg-white" />}
      </span>
      {avatar}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13.5px] font-semibold text-neutral-900 dark:text-white">{title}</span>
          {badges}
        </div>
        <div className="mt-0.5 text-[12px] text-neutral-500 dark:text-neutral-400 truncate">{subtitle}</div>
      </div>
      {action}
    </div>
  );
}
