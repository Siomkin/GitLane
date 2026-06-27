import type { OnboardingApi } from "./useOnboarding";
import { RecentRepoRow } from "./RecentRepoRow";
import { ChevronRight, CloneIcon, FolderGlyph, NewRepoIcon } from "./icons";

/** The onboarding start screen: clone / init / open actions on the left, the
 * recent-repositories list on the right. */
export const HomeScreen = ({ ob }: { ob: OnboardingApi }) => {
  return (
    <div className="grid min-h-full grid-cols-[1fr_minmax(380px,460px)]">
      {/* Left: actions */}
      <div className="flex flex-col justify-center px-16 py-14">
        <div className="mb-8 flex items-center gap-3">
          <span
            className="grid h-11 w-11 place-items-center rounded-2xl text-[15px] font-extrabold tracking-tight text-white shadow-[0_18px_44px_-8px_rgba(0,0,0,0.38)]"
            style={{ background: "linear-gradient(135deg,#5b8def,#2f9e7e,#e0843b)" }}
          >
            GL
          </span>
          <div>
            <div className="text-[22px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
              Open a repository
            </div>
            <div className="text-[14px] text-neutral-500 dark:text-neutral-400">
              Clone from a remote, start fresh, or pick up where you left off.
            </div>
          </div>
        </div>

        <div className="flex max-w-[560px] flex-col gap-2.5">
          <button
            onClick={ob.goClone}
            className="group flex w-full items-center gap-4 rounded-2xl border border-black/5 bg-white p-4 text-left shadow-sm transition-all hover:border-[color:var(--accent)] hover:shadow-md dark:border-white/5 dark:bg-neutral-800"
          >
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--accent-soft)] text-[color:var(--accent)]">
              <CloneIcon className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-semibold text-neutral-900 dark:text-neutral-50">
                Clone remote repository
              </span>
              <span className="block text-[13px] text-neutral-500 dark:text-neutral-400">
                Copy a repository from GitHub, GitLab, or any Git URL.
              </span>
            </span>
            <ChevronRight className="h-4 w-4 text-neutral-300 transition group-hover:translate-x-0.5 group-hover:text-[color:var(--accent)] dark:text-neutral-600" />
          </button>

          <button
            onClick={ob.goInit}
            className="group flex w-full items-center gap-4 rounded-2xl border border-black/5 bg-white p-4 text-left shadow-sm transition-all hover:border-[color:var(--accent)] hover:shadow-md dark:border-white/5 dark:bg-neutral-800"
          >
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--accent-soft)] text-[color:var(--accent)]">
              <NewRepoIcon className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-semibold text-neutral-900 dark:text-neutral-50">
                Initialize new repository
              </span>
              <span className="block text-[13px] text-neutral-500 dark:text-neutral-400">
                Create an empty Git repository in a local folder.
              </span>
            </span>
            <ChevronRight className="h-4 w-4 text-neutral-300 transition group-hover:translate-x-0.5 group-hover:text-[color:var(--accent)] dark:text-neutral-600" />
          </button>

          <button
            onClick={ob.openLocal}
            className="group flex w-full items-center gap-4 rounded-2xl p-4 text-left transition-all hover:bg-black/[0.03] dark:hover:bg-white/[0.03]"
          >
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-black/[0.04] text-neutral-500 dark:bg-white/[0.06] dark:text-neutral-300">
              <FolderGlyph className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-semibold text-neutral-900 dark:text-neutral-50">
                Open local folder
              </span>
              <span className="block text-[13px] text-neutral-500 dark:text-neutral-400">
                Browse for an existing repository on this machine.
              </span>
            </span>
            <ChevronRight className="h-4 w-4 text-neutral-300 transition group-hover:translate-x-0.5 dark:text-neutral-600" />
          </button>
        </div>
      </div>

      {/* Right: recent */}
      <div className="flex flex-col border-l border-black/5 bg-black/[0.015] dark:border-white/5 dark:bg-white/[0.015]">
        <div className="flex items-center justify-between px-6 pb-3 pt-7">
          <div className="text-[12px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
            Recent repositories
          </div>
          {ob.recents.length > 0 && (
            <button
              onClick={ob.clearRecents}
              className="text-[12px] font-medium text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
            >
              Clear
            </button>
          )}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 pb-4">
          {ob.recents.length === 0 ? (
            <div className="px-3 py-6 text-[12.5px] text-neutral-400 dark:text-neutral-500">
              No recent repositories yet. Clone or open one to get started.
            </div>
          ) : (
            ob.recents.map((repo) => (
              <RecentRepoRow key={repo.path} repo={repo} onOpen={() => ob.openRecent(repo)} />
            ))
          )}
        </div>
      </div>
    </div>
  );
};
