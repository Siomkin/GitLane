import type { RecentRepo } from "../../../store/repoSession";
import { avatarFor, relativeTime } from "../onboarding";
import { BranchPillIcon } from "../icons";

/** One row in the onboarding "Recent repositories" list: avatar, name (+ a
 * "Missing" badge when the path is gone), path, last-open time, and either the
 * current branch or a hover "Locate…" affordance for missing repos. */
export const RecentRepoRow = ({ repo, onOpen }: { repo: RecentRepo; onOpen: () => void }) => {
  const { initials, hue } = avatarFor(repo.name);
  const missing = !!repo.missing;
  const when = relativeTime(repo.lastOpenedAt);
  const avatarStyle = missing
    ? { background: "rgba(120,120,120,0.12)", color: "#9ca3af" }
    : { background: `hsla(${hue},60%,50%,0.15)`, color: `hsl(${hue},55%,52%)` };

  return (
    <button type="button"
      onClick={onOpen}
      title={repo.path}
      className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-white hover:shadow-sm dark:hover:bg-neutral-800"
    >
      <span
        className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[13px] font-semibold"
        style={avatarStyle}
      >
        {initials}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13.5px] font-semibold text-neutral-800 dark:text-neutral-100">
            {repo.name}
          </span>
          {missing && (
            <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
              Missing
            </span>
          )}
        </span>
        <span className="block truncate font-mono text-[11.5px] text-neutral-400 dark:text-neutral-500">
          {repo.path}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        {when && <span className="text-[11px] text-neutral-400 dark:text-neutral-500">{when}</span>}
        {missing ? (
          <span className="text-[11px] font-medium text-[color:var(--accent)] opacity-0 transition group-hover:opacity-100">
            Locate…
          </span>
        ) : repo.branch ? (
          <span className="flex items-center gap-1 text-[11px] text-neutral-400 dark:text-neutral-500">
            <BranchPillIcon className="h-3 w-3" />
            {repo.branch}
          </span>
        ) : null}
      </span>
    </button>
  );
};
