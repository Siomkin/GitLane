// One checklist row of a live progress dialog: a status glyph (faint circle →
// spinner → circled check) and the step label, dimmed until the step starts.
// Shared by the hand-off, GitHub sign-in, and delete-branch-worktree dialogs.

import { cn } from "@/lib/cn";
import { CheckIcon, CloseIcon } from "@/components/ui/icons";
import { InlineSpinner } from "@/components/ui/Loading";
import type { StepStatus } from "./stepModel";

export function StepRow({ label, status }: { label: string; status: StepStatus }) {
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
              : status === "failed"
                ? "border-rose-500/40 text-rose-600 dark:border-rose-400/40 dark:text-rose-400"
                : "border-black/15 text-transparent dark:border-white/15",
          )}
        >
          {status === "failed" ? <CloseIcon className="h-3 w-3" /> : <CheckIcon className="h-3 w-3" />}
        </span>
      )}
      <span
        className={cn(
          "text-[13px]",
          status === "pending"
            ? "text-neutral-400 dark:text-neutral-500"
            : status === "failed"
              ? "text-rose-600 dark:text-rose-400"
              : "text-neutral-700 dark:text-neutral-200",
        )}
      >
        {label}
      </span>
    </div>
  );
}
