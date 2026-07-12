// The software-update card shown in the About panel: an icon reflecting state, a
// title/subtitle, the primary action (check / install / relaunch / retry), a
// download progress bar, and release notes. All state + plugin calls live in the
// `useUpdates` store; this is just its view. The titlebar UpdateIndicator is the
// other entry point into the same flow.

import { useEffect, type ComponentType } from "react";

import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { useUpdates, type UpdateStatus } from "@/store/updates";
import { CheckIcon, RefreshIcon, UpdateIcon, WarningIcon } from "@/components/ui/icons";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const mb = n / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

type Tone = "accent" | "ok" | "danger";

const toneWrap: Record<Tone, string> = {
  accent: "bg-[var(--accent-soft)] text-[color:var(--accent)]",
  ok: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
  danger: "bg-rose-500/12 text-rose-600 dark:text-rose-400",
};

/** Icon + headline copy for each store status. `newVersion`/`version` fill the
 * subtitle; the action button is chosen separately below. */
function presentation(
  status: UpdateStatus,
  canRetry: boolean,
  version: string,
  newVersion: string | null,
  error: string | null,
): { tone: Tone; Icon: ComponentType<{ className?: string }>; spin?: boolean; title: string; sub: string } {
  switch (status) {
    case "checking":
      return { tone: "accent", Icon: RefreshIcon, spin: true, title: "Checking for updates…", sub: "Contacting the update server." };
    case "available":
      return { tone: "accent", Icon: UpdateIcon, title: "Update available", sub: `Version ${newVersion} is ready to install.` };
    case "downloading":
      return { tone: "accent", Icon: RefreshIcon, spin: true, title: "Downloading update…", sub: newVersion ? `Version ${newVersion}` : "Fetching the latest build." };
    case "ready":
      return { tone: "ok", Icon: CheckIcon, title: "Update installed", sub: `Restart to finish updating${newVersion ? ` to ${newVersion}` : ""}.` };
    case "upToDate":
      return { tone: "ok", Icon: CheckIcon, title: "You’re up to date", sub: `GitLane ${version || "—"} is the latest version.` };
    case "error":
      return { tone: "danger", Icon: WarningIcon, title: canRetry ? "Download failed" : "Update check failed", sub: error ?? "Something went wrong." };
    default:
      return { tone: "accent", Icon: RefreshIcon, title: "Check for updates", sub: version ? `You’re running GitLane ${version}.` : "See whether a newer version is available." };
  }
}

const secondaryButton = cn(
  "h-9 shrink-0 rounded-lg border border-black/[0.1] bg-black/[0.03] px-4 text-[13px] font-semibold text-neutral-700",
  "hover:bg-black/[0.06] disabled:cursor-not-allowed disabled:opacity-50",
  "dark:border-white/[0.12] dark:bg-white/[0.06] dark:text-neutral-200 dark:hover:bg-white/[0.1]",
  focusRing,
);
const accentButton = cn(
  "h-9 shrink-0 rounded-lg bg-[var(--accent)] px-4 text-[13px] font-semibold text-white shadow-sm hover:brightness-110",
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

  const canRetry = status === "error" && update !== null;
  const { tone, Icon, spin, title, sub } = presentation(status, canRetry, version, newVersion, error);

  // Narrow on contentLength (no `!`) so the percent stays type-safe.
  const pct =
    contentLength != null ? Math.min(100, Math.round((downloaded / contentLength) * 100)) : null;
  const progressLabel =
    contentLength != null
      ? `${pct}% — ${formatBytes(downloaded)} of ${formatBytes(contentLength)}`
      : downloaded > 0
        ? formatBytes(downloaded)
        : "Starting download…";

  return (
    <div className="rounded-2xl border border-black/[0.07] bg-white p-5 shadow-sm dark:border-white/[0.08] dark:bg-neutral-800/60">
      <div className="flex items-center gap-4">
        <span className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-xl", toneWrap[tone])}>
          <Icon className={cn("h-5 w-5", spin && "animate-spin")} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14.5px] font-semibold text-neutral-900 dark:text-white">{title}</div>
          <div className="mt-0.5 text-[12.5px] text-neutral-500 dark:text-neutral-400">{sub}</div>
        </div>
        {status === "ready" ? (
          <button type="button" className={accentButton} onClick={() => void restart()}>
            Relaunch
          </button>
        ) : status === "available" || canRetry ? (
          <button type="button" className={accentButton} onClick={() => void downloadAndInstall()}>
            {canRetry ? "Retry download" : "Install update"}
          </button>
        ) : status === "downloading" ? null : (
          <button type="button" className={secondaryButton} disabled={status === "checking"} onClick={() => void check()}>
            {status === "checking" ? "Checking…" : "Check for updates"}
          </button>
        )}
      </div>

      {status === "downloading" && (
        <div className="mt-4">
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
          <div className="mt-1.5 font-mono text-[11.5px] text-neutral-400 dark:text-neutral-500">{progressLabel}</div>
        </div>
      )}

      {status === "available" && notes && (
        <div className="mt-4 flex items-start gap-2 border-t border-black/[0.06] pt-4 text-[12.5px] leading-relaxed text-neutral-500 dark:border-white/[0.07] dark:text-neutral-400">
          <span className="max-h-32 flex-1 overflow-y-auto whitespace-pre-wrap">{notes}</span>
        </div>
      )}
    </div>
  );
};
