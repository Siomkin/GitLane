import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { ChevronDownIcon, ChevronRightIcon } from "@/components/ui/icons";

const iconBtn = cn(
  "grid h-7 w-7 place-items-center rounded-md text-neutral-500 hover:bg-black/5 hover:text-neutral-800 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/10 dark:hover:text-neutral-100",
  focusRing,
);

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled} className={iconBtn}>
      {children}
    </button>
  );
}

/** Difference and file navigation plus the inclusion count for the Include diff. */
export function IncludeToolbar({
  position,
  counts,
  onDifference,
  onFile,
  canPrevFile,
  canNextFile,
  extra,
}: {
  position: { index: number; total: number };
  counts: string;
  onDifference: (step: 1 | -1) => void;
  onFile: (step: 1 | -1) => void;
  canPrevFile: boolean;
  canNextFile: boolean;
  /** Trailing controls (the edit toggle). */
  extra?: ReactNode;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Include diff"
      className="flex h-9 flex-none items-center gap-1 border-b border-black/5 px-3 text-[12px] text-neutral-500 dark:border-white/5 dark:text-neutral-400"
    >
      <IconButton label="Previous difference" onClick={() => onDifference(-1)}>
        <ChevronDownIcon className="h-3.5 w-3.5 rotate-180" />
      </IconButton>
      <IconButton label="Next difference" onClick={() => onDifference(1)}>
        <ChevronDownIcon className="h-3.5 w-3.5" />
      </IconButton>
      <span aria-hidden className="mx-1 h-4 w-px bg-black/10 dark:bg-white/10" />
      <IconButton label="Previous file" onClick={() => onFile(-1)} disabled={!canPrevFile}>
        <ChevronRightIcon className="h-3.5 w-3.5 rotate-180" />
      </IconButton>
      <span className="tabular-nums" aria-label="File position">
        {position.index >= 0 ? position.index + 1 : "–"}/{position.total} files
      </span>
      <IconButton label="Next file" onClick={() => onFile(1)} disabled={!canNextFile}>
        <ChevronRightIcon className="h-3.5 w-3.5" />
      </IconButton>
      {extra}
      <span className="ml-auto" aria-live="polite">
        {counts}
      </span>
    </div>
  );
}
