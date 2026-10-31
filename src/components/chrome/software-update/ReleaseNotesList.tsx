// The What's new version list: one section per release after the running
// version, up to the offered one, newest first, with its GitHub release notes.
// With nothing offered it lists the running version and the ones before it.
// Shared by the What's new dialog and the About card. Asks the store to load the
// notes when shown; a failed load only changes this list, never the update.

import { useEffect } from "react";

import { Markdown } from "@/components/ui/Markdown";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { openExternalUrl } from "@/lib/openExternal";
import { focusRing } from "@/lib/ui";
import { RELEASES_PAGE_URL } from "@/lib/updater";
import { useUi } from "@/store/ui";
import { useUpdates } from "@/store/updates";
import { useOfferedIsSkipped } from "./shared";

const linkButton = cn("font-medium text-[color:var(--accent)] hover:underline", focusRing);
// Accent text on its own 13% wash is ~3:1; darken (lighten in dark) it to pass 4.5:1 at 11px.
const latestChip =
  "rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-medium text-[color:color-mix(in_srgb,var(--accent)_60%,black)] dark:text-[color:color-mix(in_srgb,var(--accent)_60%,white)]";

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const ReleasesLink = ({ children }: { children: string }) => (
  <button type="button" className={linkButton} onClick={() => openExternalUrl(RELEASES_PAGE_URL)}>
    {children}
  </button>
);

export const ReleaseNotesList = ({ className }: { className?: string }) => {
  const newVersion = useUpdates((s) => s.newVersion);
  const version = useUpdates((s) => s.version);
  const releaseNotes = useUpdates((s) => s.releaseNotes);
  const loadReleaseNotes = useUpdates((s) => s.loadReleaseNotes);
  const beta = useUi((s) => s.betaUpdates);
  const skipped = useOfferedIsSkipped();
  // With nothing offered, the list ends at the running version.
  const target = newVersion ?? version;

  useEffect(() => {
    void loadReleaseNotes();
  }, [loadReleaseNotes, target, beta]);

  if (!target) return null;
  const notes = releaseNotes?.forVersion === target && releaseNotes.beta === beta ? releaseNotes : null;

  if (!notes || notes.state === "loading") {
    return (
      <div className={cn("space-y-2.5", className)} role="status" aria-label="Loading release notes">
        <Skeleton className="h-3.5 w-24" />
        <Skeleton className="h-3 w-4/5" />
        <Skeleton className="h-3 w-3/5" />
      </div>
    );
  }

  if (notes.state === "error" || !notes.data) {
    return (
      <div
        className={cn(
          "rounded-lg bg-black/[0.03] px-3.5 py-3 text-[12.5px] text-neutral-500 dark:bg-white/[0.04] dark:text-neutral-400",
          className,
        )}
      >
        Couldn't load release notes. <ReleasesLink>View on GitHub</ReleasesLink>
      </div>
    );
  }

  const { releases, hasMore } = notes.data;
  return (
    <div className={cn("space-y-4", className)}>
      {!releases.some((release) => release.version === target) && (
        <div className="text-[12.5px] text-neutral-500 dark:text-neutral-400">
          No release notes for {target}. <ReleasesLink>View on GitHub</ReleasesLink>
        </div>
      )}
      {releases.map((release, i) => {
        const date = formatDate(release.publishedAt);
        const offered = release.version === newVersion;
        const installed = !newVersion && release.version === version;
        return (
          <section
            key={release.version}
            className={cn(i > 0 && "border-t border-black/[0.06] pt-4 dark:border-white/[0.07]")}
          >
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[14px] font-semibold text-neutral-900 dark:text-white">{release.version}</h3>
              {date && <span className="text-[12px] text-neutral-400 dark:text-neutral-500">{date}</span>}
              {offered && <span className={latestChip}>Latest</span>}
              {installed && <span className={latestChip}>Installed</span>}
              {offered && skipped && (
                <span className="rounded-full bg-amber-500/12 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-300">
                  Skipped
                </span>
              )}
            </div>
            <div className="mt-1.5 text-[13px] leading-relaxed text-neutral-700 dark:text-neutral-300">
              {release.body ? (
                <Markdown content={release.body} />
              ) : (
                <div className="text-[12.5px] text-neutral-400">No release notes</div>
              )}
            </div>
          </section>
        );
      })}
      {hasMore && (
        <div className="text-[12px] text-neutral-400 dark:text-neutral-500">
          Earlier versions are on GitHub. <ReleasesLink>View all releases</ReleasesLink>
        </div>
      )}
    </div>
  );
};
