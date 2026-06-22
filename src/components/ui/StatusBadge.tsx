// Status badge: a colored letter on a tinted background, matching the design.
// M(odified) A(dded) D(eleted) U(ntracked) R(enamed) etc.

import { cn } from "../../lib/cn";

const NEUTRAL_TONE = "bg-black/[0.06] text-neutral-500 dark:bg-white/10";

const STATUS_TONE: Record<string, string> = {
  m: "bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
  a: "bg-[var(--accent-soft)] text-[color:var(--accent)]",
  d: "bg-rose-500/15 text-rose-500",
  u: NEUTRAL_TONE,
  r: NEUTRAL_TONE,
  c: NEUTRAL_TONE,
  t: NEUTRAL_TONE,
};

export function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONE[status.toLowerCase()] ?? NEUTRAL_TONE;
  return (
    <span
      className={cn(
        "grid h-[18px] w-[18px] flex-none place-items-center rounded text-[10.5px] font-extrabold",
        tone,
      )}
    >
      {status}
    </span>
  );
}

const STATUS_LABEL: Record<string, string> = {
  m: "Modified",
  a: "Added",
  d: "Deleted",
  u: "Untracked",
  r: "Renamed",
  c: "Copied",
  t: "Typechange",
};

/** The word pill (e.g. "Modified") used in diff/review file headers. */
export function StatusPill({ status }: { status: string }) {
  const key = status.toLowerCase();
  const tone = STATUS_TONE[key] ?? NEUTRAL_TONE;
  const label = STATUS_LABEL[key] ?? status;
  return (
    <span
      className={cn(
        "flex-none rounded px-[7px] py-0.5 text-[10px] font-bold tracking-[0.03em]",
        tone,
      )}
    >
      {label}
    </span>
  );
}
