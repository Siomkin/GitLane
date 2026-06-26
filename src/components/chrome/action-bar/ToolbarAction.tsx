import { cn } from "../../../lib/cn";
import { focusRing } from "../../../lib/ui";
import { Spinner } from "../../ui/Loading";
import type { MouseEvent, ReactNode } from "react";

/** Icon-first toolbar button: shows the icon at rest and crossfades to a centred
 * label on hover (fixed width, so the row never reflows). Network ops swap the
 * icon for an accent spinner + `--accent-soft` wash while `pending`. */
export const ToolbarAction = ({
  label,
  icon,
  onClick,
  disabled = false,
  active = false,
  pending = false,
  wide = false,
  title,
}: {
  label: string;
  icon: ReactNode;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  active?: boolean;
  pending?: boolean;
  wide?: boolean;
  title?: string;
}) => {
  return (
    <button
      className={cn(
        "group relative inline-flex h-8 items-center justify-center rounded-lg",
        wide ? "w-16" : "w-12",
        "text-neutral-600 transition-colors hover:bg-black/5",
        "disabled:cursor-not-allowed disabled:opacity-40",
        "dark:text-neutral-300 dark:hover:bg-white/5",
        focusRing,
        active && "bg-black/5 text-[color:var(--accent)] dark:bg-white/5",
        pending && "bg-[var(--accent-soft)] hover:bg-[var(--accent-soft)]",
      )}
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
    >
      {/* Icon layer — fades out on hover; pinned visible while pending so the
          spinner stays put. Same box as the label so swapping never reflows. */}
      <span
        className={cn(
          "absolute inset-0 grid place-items-center transition-opacity duration-150",
          pending ? "opacity-100" : "group-hover:opacity-0",
        )}
      >
        <span className="grid h-[18px] w-[18px] place-items-center leading-none">
          {pending ? <Spinner accent className="h-[18px] w-[18px]" /> : icon}
        </span>
      </span>

      {/* Label layer — crossfades in on hover (suppressed while pending). */}
      <span
        className={cn(
          "absolute inset-0 grid place-items-center text-[11px] font-medium opacity-0 transition-opacity duration-150",
          !pending && "group-hover:opacity-100",
        )}
      >
        {label}
      </span>
    </button>
  );
};
