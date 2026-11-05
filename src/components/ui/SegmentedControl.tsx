// A pill track of mutually exclusive options: a `radiogroup` of `role="radio"`
// buttons with roving focus, where the arrow keys move and select (WAI-ARIA
// radio group). Used by Settings for one-of-few choices (theme, density, the
// Connect GitHub method switch).

import { useRef } from "react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  /** Extra track classes, e.g. a max width. */
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  // With nothing selected, the first option still takes Tab focus.
  const focusable = Math.max(0, options.findIndex((o) => o.value === value));

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    const last = options.length - 1;
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? index === last ? 0 : index + 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? index === 0 ? last : index - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : null;
    if (next === null) return;
    e.preventDefault();
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn("flex gap-1 rounded-lg bg-black/[0.06] p-1 dark:bg-white/[0.06]", className)}
    >
      {options.map((option, index) => {
        const selected = value === option.value;
        return (
          <button
            type="button"
            role="radio"
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            aria-checked={selected}
            tabIndex={index === focusable ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={cn(
              "flex-1 rounded-md px-2 py-1.5 text-[13px] font-semibold",
              selected
                ? "bg-white text-neutral-800 shadow-sm dark:bg-neutral-700 dark:text-neutral-100"
                : "text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100",
              focusRing,
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
