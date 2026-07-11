import type { OnboardingApi } from "../flows/useOnboarding";
import { parseRepoName } from "../onboarding";
import { SpinnerRing } from "../icons";

/** The clone-in-progress screen: a determinate bar driven by the backend's live
 * `clone-progress` events, plus a cancel control. */
export const CloneProgress = ({ ob }: { ob: OnboardingApi }) => {
  const repo = parseRepoName(ob.cloneForm.url);
  const pct = Math.round(ob.cloneRun.progress.pct);

  return (
    <div className="flex min-h-full items-center justify-center px-8">
      <div className="w-full max-w-[520px] text-center">
        <div className="mx-auto mb-6 grid h-14 w-14 place-items-center rounded-2xl bg-[var(--accent-soft)]">
          <SpinnerRing className="h-7 w-7 animate-spin text-[color:var(--accent)]" />
        </div>
        <div className="text-[18px] font-semibold text-neutral-900 dark:text-neutral-50">
          Cloning {repo}
        </div>
        <div className="mt-1 truncate font-mono text-[13.5px] text-neutral-500 dark:text-neutral-400">
          {ob.cloneForm.url}
        </div>

        <div className="mt-7 h-2 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
          <div
            className="h-full rounded-full bg-[color:var(--accent)] transition-[width] duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-2.5 flex items-center justify-between text-[12.5px]">
          <span className="font-medium text-neutral-600 dark:text-neutral-300">
            {ob.cloneRun.progress.stage}
          </span>
          <span className="font-mono text-neutral-400 dark:text-neutral-500">{pct}%</span>
        </div>

        <button
          onClick={ob.cloneRun.cancel}
          className="mt-8 h-9 rounded-xl border border-black/10 px-4 text-[13px] font-medium text-neutral-600 hover:bg-black/5 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5"
        >
          Cancel
        </button>
      </div>
    </div>
  );
};
