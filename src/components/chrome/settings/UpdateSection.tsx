// Software-update controls for the General settings panel: the running version,
// a manual "Check for Updates" action, and the offered-update flow (notes,
// download progress, restart, retry). All state + plugin calls live in the
// `useUpdates` store; this is just its view. The titlebar UpdateIndicator is the
// other entry point into the same flow.

import { useEffect } from "react";

import { cn } from "../../../lib/cn";
import { focusRing } from "../../../lib/ui";
import { useUpdates } from "../../../store/updates";
import { SectionLabel } from "./controls";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const mb = n / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

const primaryButton = cn(
  "h-8 shrink-0 rounded-lg bg-[var(--accent)] px-3.5 text-[13px] font-semibold text-white",
  "hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50",
  focusRing,
);

export const UpdateSection = () => {
  const status = useUpdates((s) => s.status);
  const version = useUpdates((s) => s.version);
  const newVersion = useUpdates((s) => s.newVersion);
  const notes = useUpdates((s) => s.notes);
  const downloaded = useUpdates((s) => s.downloaded);
  const contentLength = useUpdates((s) => s.contentLength);
  const error = useUpdates((s) => s.error);
  const update = useUpdates((s) => s.update);
  const loadVersion = useUpdates((s) => s.loadVersion);
  const check = useUpdates((s) => s.check);
  const downloadAndInstall = useUpdates((s) => s.downloadAndInstall);
  const restart = useUpdates((s) => s.restart);

  useEffect(() => {
    void loadVersion();
  }, [loadVersion]);

  const busy = status === "checking" || status === "downloading";
  // A failed download keeps the update handle, so offer a one-click retry.
  const canRetry = status === "error" && update !== null;
  // Narrow on contentLength (not a `!` assertion) so the percent + label stay
  // type-safe if this block is later refactored.
  const pct =
    contentLength != null ? Math.min(100, Math.round((downloaded / contentLength) * 100)) : null;
  const progressLabel =
    contentLength != null
      ? `Downloading… ${pct}% (${formatBytes(downloaded)} of ${formatBytes(contentLength)})`
      : `Downloading… ${formatBytes(downloaded)}`;
  const checkLabel =
    status === "checking" ? "Checking…" : status === "downloading" ? "Downloading…" : "Check for Updates";

  return (
    <div className="mt-6">
      <SectionLabel>SOFTWARE UPDATE</SectionLabel>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 text-[13px] text-neutral-600 dark:text-neutral-300">
          GitLane <span className="font-semibold">{version || "—"}</span>
          {status === "upToDate" && (
            <span className="ml-2 text-neutral-500 dark:text-neutral-400">You’re on the latest version.</span>
          )}
        </div>
        {status === "ready" ? (
          <button className={primaryButton} onClick={() => void restart()}>
            Restart now
          </button>
        ) : status === "available" || canRetry ? (
          <button className={primaryButton} onClick={() => void downloadAndInstall()}>
            {canRetry ? "Retry download" : "Download & Install"}
          </button>
        ) : (
          <button className={primaryButton} disabled={busy} onClick={() => void check()}>
            {checkLabel}
          </button>
        )}
      </div>

      {status === "available" && (
        <div className="mt-3 rounded-lg bg-black/[0.04] p-3 dark:bg-white/[0.04]">
          <div className="text-[13px] font-semibold text-neutral-700 dark:text-neutral-200">
            Version {newVersion} is available
          </div>
          {notes && (
            <p className="mt-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed text-neutral-500 dark:text-neutral-400">
              {notes}
            </p>
          )}
        </div>
      )}

      {status === "downloading" && (
        <div className="mt-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-[width]"
              style={{ width: pct === null ? "33%" : `${pct}%` }}
            />
          </div>
          <div className="mt-1.5 text-[12px] text-neutral-500 dark:text-neutral-400">{progressLabel}</div>
        </div>
      )}

      {status === "ready" && (
        <div className="mt-3 text-[12px] text-neutral-500 dark:text-neutral-400">
          Update installed. Restart GitLane to finish.
        </div>
      )}

      {status === "error" && error && (
        <div className="mt-3 text-[12px] text-rose-600 dark:text-rose-400">{error}</div>
      )}
    </div>
  );
};
