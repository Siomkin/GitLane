// The +add / −del pair shown beside a changed file. Binary files have no line
// stats, so showing "+0 −0" reads as "no change"; render a "binary" tag instead
// so the lists distinguish a binary blob from a genuinely empty text change.

import { cn } from "@/lib/cn";

export const ChangeCounts = ({
  add,
  del,
  binary = false,
  addAtLeast = false,
  className,
}: {
  add: number;
  del: number;
  binary?: boolean;
  /** The addition count is a bounded lower estimate, not an exact total. */
  addAtLeast?: boolean;
  /** Applied to the counts wrapper (callers set the font size, e.g. `text-xs`). */
  className?: string;
}) => {
  return (
    <span className={cn("inline-flex items-center", className)}>
      {binary ? (
        <span className="rounded bg-black/[0.06] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500 dark:bg-white/10 dark:text-neutral-400">
          binary
        </span>
      ) : (
        <span className="inline-flex items-center gap-2 font-mono">
          <span
            className="text-[color:var(--accent)]"
            title={
              addAtLeast
                ? `At least ${add} added lines; the large-file count was capped`
                : undefined
            }
          >
            +{addAtLeast ? "≥" : ""}
            {add}
          </span>
          <span className="text-rose-500">−{del}</span>
        </span>
      )}
    </span>
  );
};
