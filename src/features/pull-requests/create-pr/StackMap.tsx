// The target map: the new pull request on top, any open layers beneath it, and
// the branch at the bottom that the stack ultimately lands on. In base mode
// this is two rows — the same widget, fewer layers — so switching modes moves
// rows instead of swapping one control for another.

import { cn } from "@/lib/cn";
import { STACK_ROW_KIND, type StackMapRow } from "./prTargets";

export function StackMap({
  title,
  meta,
  rows,
  files,
  add,
  del,
}: {
  /** "Stack" or "Base". */
  title: string;
  /** "layer 3 of 3" / "1 pull request". */
  meta: string;
  rows: StackMapRow[];
  files: number | null;
  add: number | null;
  del: number | null;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-black/10 dark:border-white/10">
      <div className="flex h-9 items-center gap-2.5 border-b border-black/5 bg-black/[0.02] px-3 dark:border-white/5 dark:bg-white/[0.03]">
        <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-neutral-400">
          {title}
        </span>
        <span className="ml-auto flex items-center gap-2.5 whitespace-nowrap font-mono text-[11.5px] text-neutral-400">
          <span>{meta}</span>
          {files !== null && (
            <>
              <span className="h-3 w-px bg-black/10 dark:bg-white/10" />
              <span>
                {files} {files === 1 ? "file" : "files"}
              </span>
              <span className="text-[color:var(--accent)]">+{add ?? 0}</span>
              <span className="text-rose-500">&minus;{del ?? 0}</span>
            </>
          )}
        </span>
      </div>
      <div className="relative p-2">
        {/* Spine joining the layer dots; inset so it stops at the first and last
            dot rather than running past them. */}
        <span
          aria-hidden="true"
          className="absolute bottom-[26px] left-[25.5px] top-[26px] w-px bg-black/10 dark:bg-white/10"
        />
        {rows.map((row) => (
          <Row key={row.key} row={row} />
        ))}
      </div>
    </div>
  );
}

function Row({ row }: { row: StackMapRow }) {
  const isNew = row.kind === STACK_ROW_KIND.New;
  return (
    <div
      className={cn(
        "relative flex h-9 items-center gap-2 rounded-lg px-2",
        isNew
          ? "border border-dashed border-[color:var(--accent)] bg-[color:var(--accent-soft)]"
          : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]",
      )}
    >
      <span className="grid w-5 shrink-0 place-items-center">
        <span
          className={cn(
            "h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-neutral-800",
            isNew
              ? "bg-[color:var(--accent)]"
              : row.kind === STACK_ROW_KIND.Trunk
                ? "bg-neutral-400"
                : "bg-neutral-500",
          )}
        />
      </span>
      <span
        className={cn(
          "w-[22px] shrink-0 font-mono text-[10.5px] font-bold tracking-[0.04em]",
          isNew ? "text-[color:var(--accent)]" : "text-neutral-400",
        )}
      >
        {row.layer}
      </span>
      <span
        className={cn(
          "truncate font-mono text-[12.5px]",
          isNew
            ? "font-medium text-neutral-800 dark:text-neutral-100"
            : "text-neutral-600 dark:text-neutral-300",
        )}
      >
        {row.branch}
      </span>
      <span className="font-mono text-[11.5px] text-neutral-400">{row.num}</span>
      {row.state && <StatePill state={row.state} />}
      <span className="ml-auto shrink-0 text-[11.5px] text-neutral-400">{row.meta}</span>
    </div>
  );
}

function StatePill({ state }: { state: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-[19px] shrink-0 items-center rounded-full px-1.5 text-[10.5px] font-semibold",
        state === "New"
          ? "bg-[color:var(--accent)] text-white"
          : state === "Draft"
            ? "bg-neutral-500/15 text-neutral-500"
            : "bg-emerald-500/15 text-emerald-600",
      )}
    >
      {state}
    </span>
  );
}
