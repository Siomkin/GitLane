// The card's footer action: merge this PR and every unmerged layer below it in
// one atomic operation. Confirm-gated like `PrMergeMenu`, and disabled while any
// PR write is in flight so no concurrent merge can start.

import { useState } from "react";
import { cn } from "@/lib/cn";
import { Select } from "@/components/ui/Select";
import type { MergeMethod } from "@/lib/api";
import { usePulls } from "@/store/pulls";
import { useUi } from "@/store/ui";
import { MERGE_METHODS } from "@/features/pull-requests/PrMergeMenu";
import { useRunPrAction } from "@/features/pull-requests/usePrAction";
import { useStackMergePending } from "./useStackMergePending";

export function StackMergeButton({
  prNum,
  branch,
  mergeCount,
  blocked,
}: {
  prNum: number;
  branch: string;
  /** Layers this merge would land, including the viewed PR. */
  mergeCount: number;
  /** A layer in the merge set can't merge. Rendered disabled rather than
   * hidden, so the action stays visible next to the reason above it. */
  blocked: boolean;
}) {
  const mergeStack = usePulls((s) => s.mergeStack);
  const merging = useStackMergePending(prNum);
  const busy = usePulls((s) => s.prPendingActions.length > 0);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const run = useRunPrAction();
  const [method, setMethod] = useState<MergeMethod>(MERGE_METHODS[0]?.key ?? "merge");

  const doMerge = () => {
    const label = MERGE_METHODS.find((m) => m.key === method)?.label ?? "Merge";
    const layers = mergeCount === 1 ? "1 pull request" : `${mergeCount} pull requests`;
    requestConfirm({
      title: `Merge ${layers} as a stack?`,
      // Spell out the all-or-nothing contract — it's the whole reason to use
      // this instead of merging each PR by hand.
      message:
        mergeCount === 1
          ? `${label} #${prNum} (${branch}). This can't be undone.`
          : `${label} #${prNum} (${branch}) and every unmerged layer below it, in one operation. ` +
            `If any layer can't merge, none of them do. This can't be undone.`,
      confirmLabel: "Merge stack",
      onConfirm: () => void run(() => mergeStack(prNum, method)),
    });
  };

  return (
    <div className="flex items-center gap-2 border-t border-black/5 bg-black/[0.015] px-3.5 py-3 dark:border-white/10 dark:bg-white/[0.02]">
      <button
        type="button"
        onClick={doMerge}
        disabled={busy || blocked}
        aria-busy={merging}
        title={blocked ? "Some pull requests in this stack cannot be merged" : undefined}
        className={cn(
          "flex h-8 items-center gap-2 rounded-lg px-3 text-[13px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]",
          blocked
            ? "cursor-not-allowed bg-black/[0.06] text-neutral-400 dark:bg-white/10"
            : "bg-emerald-600 text-white hover:brightness-110 disabled:opacity-45 dark:bg-emerald-500",
        )}
      >
        {merging ? "Merging stack…" : "Merge stack"}
        <span
          className={cn(
            "grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[11px] font-semibold tabular-nums",
            blocked ? "bg-black/10 dark:bg-white/10" : "bg-black/20",
          )}
        >
          {mergeCount}
        </span>
      </button>
      {MERGE_METHODS.length > 1 && (
        <label className="flex items-center gap-1.5 text-[12px] text-neutral-500 dark:text-neutral-400">
          <span className="sr-only">Merge method</span>
          <Select
            value={method}
            onChange={(e) => setMethod(e.target.value as MergeMethod)}
            disabled={busy}
            className="h-8 rounded-lg border border-black/10 bg-white px-2 text-[12.5px] text-neutral-700 disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] dark:border-white/15 dark:bg-neutral-800 dark:text-neutral-200"
          >
            {MERGE_METHODS.map((m) => (
              <option key={m.key} value={m.key} className="dark:bg-neutral-800">
                {m.label}
              </option>
            ))}
          </Select>
        </label>
      )}
    </div>
  );
}
