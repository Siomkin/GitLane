/** Static explainer: which providers expose pull requests, and what an invalid
 * URL means. Mirrors the design's "PULL-REQUEST AVAILABILITY" footer. */
const ROWS: { dot: string; label: string; note: string }[] = [
  { dot: "bg-emerald-500", label: "GitHub", note: "pull requests, checks and review threads are available." },
  {
    dot: "bg-neutral-400",
    label: "GitLab · Bitbucket · Azure",
    note: "browsing, push, fetch and pull work; PR features are unavailable.",
  },
  { dot: "bg-rose-500", label: "Invalid URL", note: "not saved; fix the host or owner/repo path." },
];

export const PrAvailabilityLegend = () => (
  <div className="rounded-xl border border-black/[0.07] bg-black/[0.02] p-4 dark:border-white/[0.08] dark:bg-black/20">
    <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-400 dark:text-neutral-500">
      Pull-request availability
    </div>
    <div className="flex flex-col gap-2 text-[12.5px] text-neutral-500 dark:text-neutral-400">
      {ROWS.map((r) => (
        <div key={r.label} className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${r.dot}`} />
          <span className="font-medium text-neutral-700 dark:text-neutral-200">{r.label}</span> — {r.note}
        </div>
      ))}
    </div>
  </div>
);
