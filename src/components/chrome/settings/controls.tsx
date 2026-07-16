// Small controls reused by settings panels. One-off controls stay co-located
// in their panel.

import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";

/** Uppercase section heading above a group of settings controls. */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-[11px] text-[11px] font-bold tracking-[0.05em] text-neutral-500 dark:text-neutral-400">
      {children}
    </div>
  );
}

export function SettingsSwitch({
  checked,
  ariaLabel,
  onChange,
}: {
  checked: boolean;
  ariaLabel: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition-colors",
        checked ? "justify-end bg-[var(--accent)]" : "justify-start bg-black/15 dark:bg-white/20",
        focusRing,
      )}
    >
      <span className="h-5 w-5 rounded-full bg-white shadow-sm" />
    </button>
  );
}
