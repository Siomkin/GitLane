import type { RecentRepo } from "@/store/repoSession";
import { avatarFor, recentIdentity } from "@/features/onboarding/onboarding";
import { relativeTime } from "@/lib/relativeTime";
import { repoGroupColorStyles, repoGroupOf, repoNameOf, useUi } from "@/store/ui";
import { cn } from "@/lib/cn";
import { BranchPillIcon } from "@/features/onboarding/icons";
import { CloseIcon } from "@/components/ui/icons";

/** One row in the onboarding "Recent repositories" list: avatar (with a group badge), name (+ a
 * "Missing" badge when the path is gone), path, last-open time, and either the
 * current branch or a hover "Locate…" affordance for missing repos. A trailing ×,
 * shown in the time label's place on hover or keyboard focus, removes the entry. */
export const RecentRepoRow = ({
  repo,
  onOpen,
  onRemove,
}: {
  repo: RecentRepo;
  onOpen: () => void;
  onRemove: () => void;
}) => {
  // The user's own name for the repository wins over the folder-derived one the
  // recents entry was recorded with — the same label its tabs carry, resolved
  // through the same repository identity so a worktree row inherits it too.
  const repoLabelsByIdentity = useUi((state) => state.repoLabelsByIdentity);
  const repoGroups = useUi((state) => state.repoGroups);
  const identity = recentIdentity(repo);
  const name = repoNameOf({ repoGroups, repoLabelsByIdentity }, identity) ?? repo.name;
  const group = repoGroupOf({ repoGroups, repoLabelsByIdentity }, identity);
  const { initials, hue } = avatarFor(name);
  const missing = !!repo.missing;
  // `lastOpenedAt` is epoch ms (`Date.now()`); the shared formatter takes seconds.
  const when = relativeTime(repo.lastOpenedAt / 1000, { long: true });
  const avatarStyle = missing
    ? { background: "rgba(120,120,120,0.12)", color: "#9ca3af" }
    : { background: `hsla(${hue},60%,50%,0.15)`, color: `hsl(${hue},55%,52%)` };

  return (
    // A div, not one button: the remove control is a second button beside the row's own.
    // On hover it takes the time label's place, so it costs no width.
    <div className="group relative flex items-center rounded-xl transition hover:bg-white hover:shadow-sm focus-within:bg-white dark:hover:bg-neutral-800 dark:focus-within:bg-neutral-800">
      <button type="button"
        onClick={onOpen}
        title={repo.path}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2.5 text-left"
      >
        <span
          className="relative grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[13px] font-semibold"
          style={avatarStyle}
        >
          {initials}
          {/* The group as a badge on the avatar, so the name keeps its position. */}
          {group && (
            <span
              role="img"
              aria-label={group.name}
              title={group.name}
              className={cn(
                "absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-neutral-800",
                repoGroupColorStyles[group.color].dot,
              )}
            />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13.5px] font-semibold text-neutral-800 dark:text-neutral-100">
              {name}
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
          {when && (
            <span className="text-[11px] text-neutral-400 transition group-focus-within:opacity-0 group-hover:opacity-0 dark:text-neutral-500">
              {when}
            </span>
          )}
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
      <button type="button"
        onClick={onRemove}
        aria-label={`Remove ${name} from recent repositories`}
        title="Remove from recents"
        className="absolute right-2 top-2 grid h-5 w-5 place-items-center rounded-md text-neutral-400 opacity-0 transition hover:bg-black/5 hover:text-neutral-700 focus-visible:opacity-100 group-hover:opacity-100 dark:text-neutral-500 dark:hover:bg-white/10 dark:hover:text-neutral-200"
      >
        <CloseIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};
