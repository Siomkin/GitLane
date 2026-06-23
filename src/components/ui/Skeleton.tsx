// Skeleton placeholders. PR data comes from the `gh` CLI (network) and can take
// a couple seconds; mirroring the content's shape while it loads reads as
// "loading" instead of a frozen or empty panel (a bare centered spinner did).

import type { CSSProperties } from "react";

import { cn } from "../../lib/cn";

/** A single shimmering placeholder bar. Compose these to mimic real content. */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <span aria-hidden style={style} className={cn("gp-skeleton block", className)} />;
}

/** Sidebar PR list placeholder: a few card-shaped rows. */
export function PrListSkeleton() {
  return (
    <div aria-busy="true">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="border-b border-black/10 px-3.5 py-3 dark:border-white/10">
          <div className="mb-2 flex items-center gap-2">
            <Skeleton className="h-3 w-7" />
            <Skeleton className="h-3 w-14" />
            <span className="flex-1" />
            <Skeleton className="h-3 w-8" />
          </div>
          <Skeleton className="h-3.5 w-[85%]" />
          <div className="mt-2.5 flex items-center gap-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-12" />
            <span className="flex-1" />
            <Skeleton className="h-3 w-10" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** PR detail body placeholder: metric cards + a description block. */
export function PrDetailSkeleton() {
  return (
    <div aria-busy="true">
      <div className="mb-6 grid grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border border-black/10 bg-black/[0.03] px-[15px] py-[13px] dark:border-white/10 dark:bg-white/[0.04]"
          >
            <Skeleton className="h-2.5 w-12" />
            <Skeleton className="mt-2.5 h-4 w-16" />
          </div>
        ))}
      </div>
      <Skeleton className="mb-4 h-2.5 w-20" />
      <div className="flex flex-col gap-2.5">
        <Skeleton className="h-3.5 w-[95%]" />
        <Skeleton className="h-3.5 w-[88%]" />
        <Skeleton className="h-3.5 w-[92%]" />
        <Skeleton className="h-3.5 w-[60%]" />
      </div>
    </div>
  );
}
