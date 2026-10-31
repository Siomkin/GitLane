// The pieces the What's new dialog and the About card's software-update card
// share: the card's button treatments, the download progress bar, and whether
// the offered version is the one the user skipped. State lives in `useUpdates`.

import { formatBytes } from "@/lib/binaryFile";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { useUi } from "@/store/ui";
import { useUpdates } from "@/store/updates";

export const secondaryButton = cn(
  "h-9 shrink-0 rounded-lg border border-black/[0.1] bg-black/[0.03] px-4 text-[13px] font-semibold text-neutral-700",
  "hover:bg-black/[0.06] disabled:cursor-not-allowed disabled:opacity-50",
  "dark:border-white/[0.12] dark:bg-white/[0.06] dark:text-neutral-200 dark:hover:bg-white/[0.1]",
  focusRing,
);
export const accentButton = cn(
  "h-9 shrink-0 rounded-lg bg-[var(--accent)] px-4 text-[13px] font-semibold text-white shadow-sm hover:brightness-110",
  focusRing,
);
/** The low-key "Skip this version" treatment: text only, so Install stays the one primary. */
export const quietButton = cn(
  "h-9 shrink-0 rounded-lg px-2 text-[13px] text-neutral-500 hover:bg-black/5 hover:text-neutral-700",
  "dark:text-neutral-400 dark:hover:bg-white/5 dark:hover:text-neutral-200",
  focusRing,
);

/** True when the offered version is the one the user skipped (so only a manual
 * check could have offered it). */
export function useOfferedIsSkipped(): boolean {
  const newVersion = useUpdates((s) => s.newVersion);
  const skipped = useUi((s) => s.skippedUpdateVersion);
  return newVersion !== null && newVersion === skipped;
}

/** The download bar: a fill once the size is known, a moving segment before. */
export const DownloadProgress = () => {
  const downloaded = useUpdates((s) => s.downloaded);
  const contentLength = useUpdates((s) => s.contentLength);

  // Narrow on contentLength (no `!`) so the percent stays type-safe.
  const pct =
    contentLength != null ? Math.min(100, Math.round((downloaded / contentLength) * 100)) : null;
  const label =
    contentLength != null
      ? `${pct}% — ${formatBytes(downloaded)} of ${formatBytes(contentLength)}`
      : downloaded > 0
        ? formatBytes(downloaded)
        : "Starting download…";

  return (
    <div>
      <div className="h-1.5 overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/10">
        {pct === null ? (
          // Unknown size / pre-Started: a moving segment, not a frozen fill.
          <div className="gp-indeterminate-bar h-full rounded-full bg-[var(--accent)]" />
        ) : (
          <div
            className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-150 ease-linear"
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
      <div className="mt-1.5 font-mono text-[11.5px] text-neutral-400 dark:text-neutral-500">{label}</div>
    </div>
  );
};
