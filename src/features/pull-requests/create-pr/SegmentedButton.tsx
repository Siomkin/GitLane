// The pill-in-a-track button used by both segmented controls in this dialog —
// the target mode and the description's Write/Preview.

import { cn } from "@/lib/cn";

export function SegmentedButton({
  active,
  onClick,
  size = "md",
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  /** "sm" inside the description toolbar, "md" for the target control. */
  size?: "sm" | "md";
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        "whitespace-nowrap rounded-md font-medium transition-colors",
        size === "sm" ? "h-7 px-2.5 text-[12.5px]" : "h-8 px-3 text-[12.5px]",
        active
          ? "bg-white text-neutral-800 shadow-sm dark:bg-neutral-700 dark:text-neutral-100"
          : "text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200",
      )}
    >
      {children}
    </button>
  );
}
