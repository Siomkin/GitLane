// One checklist row of the hand-off progress list: a status glyph (faint circle
// → spinner → circled check) and the step label, dimmed until the step starts.

import { cn } from "@/lib/cn";
import { CheckIcon } from "@/components/ui/icons";
import { InlineSpinner } from "@/components/ui/Loading";
import type { HandoffStepStatus } from "./steps";

export function StepRow({ label, status }: { label: string; status: HandoffStepStatus }) {
  return (
    <div className="flex items-center gap-3" data-status={status}>
      {status === "active" ? (
        <InlineSpinner className="h-[18px] w-[18px] shrink-0 text-neutral-400" />
      ) : (
        <span
          className={cn(
            "grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border",
            status === "done"
              ? "border-[color:var(--accent)]/40 text-[color:var(--accent)]"
              : "border-black/15 text-transparent dark:border-white/15",
          )}
        >
          <CheckIcon className="h-3 w-3" />
        </span>
      )}
      <span
        className={cn(
          "text-[13px]",
          status === "pending"
            ? "text-neutral-400 dark:text-neutral-500"
            : "text-neutral-700 dark:text-neutral-200",
        )}
      >
        {label}
      </span>
    </div>
  );
}
