import type { CSSProperties } from "react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { CheckIcon } from "@/components/ui/icons";

/** A compact checkbox that can also show a partly-checked dash. A real
 * `<button role="checkbox">` so it can sit beside (not inside) a row button.
 * `disabledReason`, when set, blocks the click and becomes the tooltip. */
export function TriStateCheckbox({
  checked,
  label,
  onChange,
  disabledReason,
  className,
  style,
}: {
  checked: boolean | "mixed";
  label: string;
  onChange: () => void;
  disabledReason?: string | null;
  className?: string;
  style?: CSSProperties;
}) {
  const disabled = !!disabledReason;
  const on = checked !== false;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      title={disabledReason ?? label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onChange();
      }}
      style={style}
      className={cn(
        "grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border-[1.5px] transition-colors",
        focusRing,
        // Soft tint, not a solid fill; an unchecked box stays invisible until
        // its row (a `group`) is hovered, the box is hovered, or it has focus.
        on
          ? "border-[color:var(--accent)]/40 bg-[var(--accent)]/10 text-[color:var(--accent)]"
          : "border-transparent bg-transparent group-hover:border-black/25 hover:border-[color:var(--accent)]/60 hover:bg-[var(--accent)]/10 focus-visible:border-black/25 dark:group-hover:border-white/25 dark:focus-visible:border-white/25",
        disabled && "cursor-not-allowed opacity-45",
        className,
      )}
    >
      {checked === true && <CheckIcon className="h-3 w-3" />}
      {checked === "mixed" && <span aria-hidden className="h-0.5 w-2 rounded bg-current" />}
    </button>
  );
}
