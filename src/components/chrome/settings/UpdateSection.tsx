// The software-update card shown in the About panel: an icon reflecting state, a
// title/subtitle, the actions (check / install / skip / relaunch / retry), a
// download progress bar, and the What's new version list. All state + plugin
// calls live in the `useUpdates` store; this is just its view. The titlebar
// UpdateIndicator opens the other view of the same flow, the What's new dialog.

import { useEffect, useState, type ComponentType } from "react";

import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { useUpdates, type UpdateStatus } from "@/store/updates";
import { CheckIcon, ChevronDownIcon, RefreshIcon, UpdateIcon, WarningIcon } from "@/components/ui/icons";
import {
  DownloadProgress,
  ReleaseNotesList,
  accentButton,
  secondaryButton,
  useOfferedIsSkipped,
} from "@/components/chrome/software-update";

type Tone = "accent" | "ok" | "danger";

const toneWrap: Record<Tone, string> = {
  accent: "bg-[var(--accent-soft)] text-[color:var(--accent)]",
  ok: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
  danger: "bg-rose-500/12 text-rose-600 dark:text-rose-400",
};

/** Icon + headline copy for each store status. `newVersion`/`version` fill the
 * subtitle; the action button is chosen separately below. */
function presentation(
  supported: boolean,
  status: UpdateStatus,
  canRetry: boolean,
  skipped: boolean,
  version: string,
  newVersion: string | null,
  error: string | null,
): { tone: Tone; Icon: ComponentType<{ className?: string }>; spin?: boolean; title: string; sub: string } {
  if (!supported) {
    return {
      tone: "accent",
      Icon: RefreshIcon,
      title: "Source build",
      sub: "Pull the latest source and rebuild GitLane to update.",
    };
  }
  switch (status) {
    case "checking":
      return { tone: "accent", Icon: RefreshIcon, spin: true, title: "Checking for updates…", sub: "Contacting the update server." };
    case "available":
      return {
        tone: "accent",
        Icon: UpdateIcon,
        title: "Update available",
        sub: skipped ? `Version ${newVersion} — you skipped this version.` : `Version ${newVersion} is ready to install.`,
      };
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

export const UpdateSection = () => {
  const supported = useUpdates((s) => s.supported);
  const status = useUpdates((s) => s.status);
  const version = useUpdates((s) => s.version);
  const newVersion = useUpdates((s) => s.newVersion);
  const error = useUpdates((s) => s.error);
  const update = useUpdates((s) => s.update);
  const loadVersion = useUpdates((s) => s.loadVersion);
  const check = useUpdates((s) => s.check);
  const downloadAndInstall = useUpdates((s) => s.downloadAndInstall);
  const restart = useUpdates((s) => s.restart);
  const skip = useUpdates((s) => s.skip);
  const skipped = useOfferedIsSkipped();
  const [notesOpen, setNotesOpen] = useState(true);

  useEffect(() => {
    void loadVersion();
  }, [loadVersion]);

  const canRetry = status === "error" && update !== null;
  const { tone, Icon, spin, title, sub } = presentation(supported, status, canRetry, skipped, version, newVersion, error);

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
        {!supported ? null : status === "ready" ? (
          <button type="button" className={accentButton} onClick={() => void restart()}>
            Relaunch
          </button>
        ) : status === "available" || canRetry ? (
          <div className="flex shrink-0 gap-2">
            {status === "available" && !skipped && (
              <button type="button" className={secondaryButton} onClick={() => void skip()}>
                Skip this version
              </button>
            )}
            <button type="button" className={accentButton} onClick={() => void downloadAndInstall()}>
              {canRetry ? "Retry download" : "Install update"}
            </button>
          </div>
        ) : status === "downloading" ? null : (
          <button type="button" className={secondaryButton} disabled={status === "checking"} onClick={() => void check()}>
            {status === "checking" ? "Checking…" : "Check for updates"}
          </button>
        )}
      </div>

      {status === "downloading" && (
        <div className="mt-4">
          <DownloadProgress />
        </div>
      )}

      {supported && newVersion && (
        <div className="mt-4 border-t border-black/[0.06] pt-3 dark:border-white/[0.07]">
          <button
            type="button"
            aria-expanded={notesOpen}
            onClick={() => setNotesOpen((o) => !o)}
            className={cn(
              "flex items-center gap-1.5 rounded text-[12.5px] font-medium text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200",
              focusRing,
            )}
          >
            <ChevronDownIcon className={cn("h-3.5 w-3.5 transition-transform", !notesOpen && "-rotate-90")} />
            What's new
          </button>
          {/* Hidden, not unmounted: remounting would retry a failed load on every expand. */}
          <div hidden={!notesOpen}>
            <ReleaseNotesList className="mt-3 max-h-60 overflow-y-auto pr-1" />
          </div>
        </div>
      )}
    </div>
  );
};
