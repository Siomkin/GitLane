// Shown when the repo overrides its applied profile's commit email with a
// hand-edited one. Makes the override explicit and offers the only thing that
// rewrites it — an opt-in "Reset to default". The persistence guarantee (the
// custom email survives switching profiles away and back) lives in the store;
// this just surfaces it.

import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";

export function CustomEmailNotice({
  profileLabel,
  profileEmail,
  onReset,
}: {
  profileLabel: string;
  profileEmail: string;
  onReset: () => void;
}) {
  return (
    <div className="mt-4 p-4 rounded-xl border border-black/[0.07] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.03]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex items-center gap-1.5 px-2 h-6 rounded-full text-[11px] font-semibold text-[color:var(--accent)] bg-[var(--accent-soft)] shrink-0 whitespace-nowrap">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3 shrink-0">
              <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
            </svg>
            Custom email
          </span>
          <span className="text-[12px] text-neutral-500 dark:text-neutral-400 truncate">
            This repo overrides {profileLabel}’s <span className="font-mono text-[11.5px]">{profileEmail}</span>
          </span>
        </div>
        <button
          onClick={onReset}
          className={cn(
            "inline-flex items-center gap-1 text-[11.5px] font-semibold text-[color:var(--accent)] hover:underline shrink-0",
            focusRing,
          )}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
            <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
            <path d="M21 3v5h-5" />
          </svg>
          Reset to default
        </button>
      </div>
      <p className="mt-2.5 text-[12px] text-neutral-500 dark:text-neutral-400 text-pretty">
        Switching profiles or accounts never rewrites a commit email you edited by hand. Only{" "}
        <span className="font-medium text-neutral-700 dark:text-neutral-200">Reset to default</span> does — and only
        when you click it.
      </p>
    </div>
  );
}
