import { useState } from "react";
import type { ReviewThread } from "@/lib/api";
import { usePulls } from "@/store/pulls";
import { InlineSpinner } from "@/components/ui/Loading";
import { useRunPrAction } from "./usePrAction";

interface ReviewThreadControlsProps {
  prNum: number;
  thread: ReviewThread;
}

export const ReviewThreadControls = ({ prNum, thread }: ReviewThreadControlsProps) => {
  const resolveThread = usePulls((s) => s.resolveThread);
  const run = useRunPrAction();
  const [pending, setPending] = useState(false);

  const toggleResolved = async () => {
    if (pending) return;
    setPending(true);
    try {
      await run(() => resolveThread(prNum, thread.id, !thread.isResolved));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex items-center gap-3 border-t border-black/5 bg-black/[0.015] px-3.5 py-2.5 dark:border-white/5 dark:bg-white/[0.02]">
        <button type="button"
          onClick={toggleResolved}
          disabled={pending}
          aria-busy={pending}
          className="inline-flex items-center gap-1.5 rounded-md border border-black/10 px-2.5 py-1 text-[11.5px] font-medium text-neutral-700 hover:bg-black/5 disabled:opacity-45 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
        >
          {pending && <InlineSpinner className="h-3 w-3" />}
          {thread.isResolved ? "Unresolve conversation" : "Resolve conversation"}
        </button>
        {thread.isResolved && (
          <span className="truncate text-[12px] text-neutral-400">This conversation is resolved.</span>
        )}
    </div>
  );
};
