// Compact key-cap badges for a keyboard shortcut. Domain-free: the caller
// supplies already-platform-formatted tokens (`⌘` / `Ctrl`).

import { cn } from "@/lib/cn";

export function ShortcutHint({
  keys,
  size = "sm",
  tone = "default",
}: {
  keys: readonly string[];
  size?: "sm" | "md";
  /** `onAccent` is for solid accent/danger buttons whose label is already white. */
  tone?: "default" | "onAccent";
}) {
  if (keys.length === 0) return null;
  const onAccent = tone === "onAccent";
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5" aria-hidden>
      {keys.map((key, i) => (
        <kbd
          key={`${i}-${key}`}
          className={cn(
            "inline-flex items-center justify-center font-sans font-semibold",
            onAccent
              ? "border border-white/30 bg-white/15 text-white"
              : "border border-black/10 bg-black/[0.05] text-neutral-500 dark:border-white/10 dark:bg-white/[0.08] dark:text-neutral-400",
            size === "md"
              ? "min-w-[22px] rounded-md px-1.5 py-0.5 text-[12px]"
              : "min-w-[18px] rounded-[5px] px-1 py-px text-[10.5px] leading-[16px]",
          )}
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}
