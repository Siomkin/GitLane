import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { CheckIcon, WarningIcon } from "@/components/ui/icons";

/** `success` / `failure` draw their own check / warning; `danger` (a destructive
 * confirm) and `neutral` (configuring or running) show the dialog's `icon`. */
export type OutcomeTone = "success" | "failure" | "danger" | "neutral";

const TONE_CLASS: Record<OutcomeTone, string> = {
  success: "bg-emerald-500/15 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-400",
  failure: "bg-rose-500/15 text-rose-600 dark:bg-rose-400/15 dark:text-rose-400",
  danger: "bg-rose-500/[0.12] text-rose-600 dark:bg-rose-400/15 dark:text-rose-400",
  neutral:
    "border border-black/10 bg-black/[0.025] text-neutral-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-neutral-200",
};

/** The 40px header badge of the progress / sign-in dialogs: it tracks the run's
 * outcome (Codex-style) — green check on success, rose warning on failure. */
export function OutcomeBadge({ tone, icon }: { tone: OutcomeTone; icon: ReactNode }) {
  return (
    <span className={cn("grid h-10 w-10 place-items-center rounded-xl", TONE_CLASS[tone])}>
      {tone === "success" ? (
        <CheckIcon className="h-5 w-5" />
      ) : tone === "failure" ? (
        <WarningIcon className="h-5 w-5" />
      ) : (
        icon
      )}
    </span>
  );
}
