import type { OnboardingApi } from "./useOnboarding";
import { BranchPillIcon, CheckGlyph, ChevronLeft, FolderGlyph } from "./icons";

/** The post-clone ("opened") and post-init ("empty") confirmation screens. Both
 * show a repo header (name + branch + path) and a success body; the primary
 * action opens the repo in GitLane (entering the main app shell). */
export const OnboardingSuccess = ({ ob }: { ob: OnboardingApi }) => {
  const result = ob.result;
  if (!result) return null;
  const isEmpty = result.screen === "empty";

  return (
    <div className="flex min-h-full flex-col">
      {/* Repo header */}
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-black/5 px-6 dark:border-white/5">
        {isEmpty ? (
          <button
            onClick={ob.goHome}
            className="grid h-8 w-8 place-items-center rounded-lg text-neutral-400 hover:bg-black/5 dark:hover:bg-white/5"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        ) : (
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--accent-soft)] text-[color:var(--accent)]">
            <FolderGlyph className="h-4 w-4" strokeWidth={1.8} />
          </span>
        )}
        <span className="text-[14px] font-semibold text-neutral-800 dark:text-neutral-100">
          {result.name}
        </span>
        <span className="flex items-center gap-1 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[12px] font-medium text-[color:var(--accent)]">
          <BranchPillIcon className="h-3 w-3" />
          {result.branch}
        </span>
        <span className="ml-auto truncate font-mono text-[12px] text-neutral-400 dark:text-neutral-500">
          {result.path}
        </span>
      </div>

      {/* Success body */}
      <div className="grid flex-1 place-items-center px-8">
        <div className="max-w-[460px] text-center">
          <div className="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-2xl bg-emerald-500/15 text-emerald-500">
            <CheckGlyph className="h-7 w-7" />
          </div>

          {isEmpty ? (
            <>
              <div className="text-[19px] font-semibold text-neutral-900 dark:text-neutral-50">
                Repository initialized
              </div>
              <div className="mt-1.5 text-[14px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                An empty Git repository was created on branch{" "}
                <span className="font-mono font-medium text-neutral-700 dark:text-neutral-200">
                  {result.branch}
                </span>
                . There are no commits yet — make your first one to get started.
              </div>
              <div className="mt-6 flex items-center justify-center gap-2.5">
                <button
                  onClick={ob.revealResult}
                  className="h-10 rounded-xl border border-black/10 px-4 text-[13.5px] font-medium text-neutral-600 hover:bg-black/5 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5"
                >
                  Reveal in Finder
                </button>
                <button
                  onClick={ob.enterResult}
                  className="h-10 rounded-xl bg-[color:var(--accent)] px-5 text-[13.5px] font-semibold text-white shadow-sm hover:brightness-110"
                >
                  Open in GitLane
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="text-[19px] font-semibold text-neutral-900 dark:text-neutral-50">
                Cloned {result.name}
              </div>
              <div className="mt-1.5 text-[14px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                Checked out{" "}
                <span className="font-mono font-medium text-neutral-700 dark:text-neutral-200">
                  {result.branch}
                </span>{" "}
                into {result.path}.
              </div>
              <div className="mt-6 inline-flex items-center gap-2 text-[12.5px] text-neutral-400 dark:text-neutral-500">
                <CheckGlyph className="h-4 w-4 text-emerald-500" />
                Checked out {result.branch} — ready to start working
              </div>
              <div className="mt-6 flex items-center justify-center gap-2.5">
                <button
                  onClick={ob.enterResult}
                  className="h-10 rounded-xl bg-[color:var(--accent)] px-5 text-[13.5px] font-semibold text-white shadow-sm hover:brightness-110"
                >
                  Start working
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
