// The What's new version list: one section per release after the running
// version, up to the offered one, newest first, with its GitHub release notes.
// Shared by the What's new dialog and the About card. Asks the store to load the
// notes when shown; a failed load only changes this list, never the update.

import { useEffect } from "react";

import { Markdown } from "@/components/ui/Markdown";
import { cn } from "@/lib/cn";
import { openExternalUrl } from "@/lib/openExternal";
import { focusRing } from "@/lib/ui";
import { RELEASES_PAGE_URL } from "@/lib/updater";
import { useUpdates } from "@/store/updates";
import { useOfferedIsSkipped } from "./UpdateActions";

const linkButton = cn("font-medium text-[color:var(--accent)] hover:underline", focusRing);

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
  const releaseNotes = useUpdates((s) => s.releaseNotes);
  const loadReleaseNotes = useUpdates((s) => s.loadReleaseNotes);
  const skipped = useOfferedIsSkipped();

  useEffect(() => {
    void loadReleaseNotes();
  }, [loadReleaseNotes, newVersion]);

  if (!newVersion) return null;
  const notes = releaseNotes?.forVersion === newVersion ? releaseNotes : null;

  if (!notes || notes.state === "loading") {
    return (
      <div className={cn("space-y-2.5", className)} aria-busy="true" aria-label="Loading release notes">
        <div className="h-3.5 w-24 animate-pulse rounded bg-black/[0.07] dark:bg-white/10" />
        <div className="h-3 w-4/5 animate-pulse rounded bg-black/[0.05] dark:bg-white/[0.07]" />
        <div className="h-3 w-3/5 animate-pulse rounded bg-black/[0.05] dark:bg-white/[0.07]" />
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
      {releases.length === 0 && (
        <div className="text-[12.5px] text-neutral-500 dark:text-neutral-400">
          No release notes for {newVersion}. <ReleasesLink>View on GitHub</ReleasesLink>
        </div>
      )}
      {releases.map((release, i) => {
        const date = formatDate(release.publishedAt);
        return (
          <section
            key={release.version}
            className={cn(i > 0 && "border-t border-black/[0.06] pt-4 dark:border-white/[0.07]")}
          >
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[14px] font-semibold text-neutral-900 dark:text-white">{release.version}</h3>
              {date && <span className="text-[12px] text-neutral-400 dark:text-neutral-500">{date}</span>}
              {i === 0 && (
                <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--accent)]">
                  Latest
                </span>
              )}
              {i === 0 && skipped && (
                <span className="rounded-full bg-amber-500/12 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
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
