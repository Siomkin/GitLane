import type { RecentRepo } from "@/store/repoSession";
import { cn } from "@/lib/cn";
import { repoGroupColorStyles, type RepoGroup } from "@/store/ui";
import { RecentRepoRow } from "./RecentRepoRow";

/** One section of the recent-repositories list: a user group's entries under a
 * coloured heading, or — with no `group` — the ungrouped remainder, which is
 * headless when it is the whole list (nothing to distinguish it from). */
export const RecentGroupSection = ({
  group,
  repos,
  showUngroupedHeading,
  onOpen,
}: {
  group: RepoGroup | null;
  repos: RecentRepo[];
  showUngroupedHeading: boolean;
  onOpen: (repo: RecentRepo) => void;
}) => (
  <div className="flex flex-col gap-0.5">
    {group ? (
      <div className="flex items-center gap-1.5 px-3 pb-1 pt-2">
        <span
          aria-hidden="true"
          className={cn("h-2 w-2 shrink-0 rounded-full", repoGroupColorStyles[group.color].dot)}
        />
        <span className="truncate text-[11.5px] font-semibold text-neutral-500 dark:text-neutral-400">
          {group.name}
        </span>
      </div>
    ) : (
      showUngroupedHeading && (
        <div className="px-3 pb-1 pt-2 text-[11.5px] font-semibold text-neutral-400 dark:text-neutral-500">
          Ungrouped
        </div>
      )
    )}
    {repos.map((repo) => (
      <RecentRepoRow key={repo.path} repo={repo} onOpen={() => onOpen(repo)} />
    ))}
  </div>
);
