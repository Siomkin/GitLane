import type { OnboardingApi } from "./useOnboarding";
import { RetryIcon, WarningTriangle, XCircle } from "./icons";

/** The clone-failed screen. Renders the classified copy (exists / auth /
 * unreachable / canceled / generic): a fail uses the red warning triangle, a
 * cancel the neutral crossed circle, and the git `fatal:` line is shown verbatim
 * in a terminal block. */
export const OnboardingError = ({ ob }: { ob: OnboardingApi }) => {
  const error = ob.error;
  if (!error) return null;

  return (
    <div className="flex min-h-full items-center justify-center px-8">
      <div className="w-full max-w-[520px] text-center">
        <div
          className={`mx-auto mb-6 grid h-14 w-14 place-items-center rounded-2xl ${
            error.fail ? "bg-red-500/15" : "bg-neutral-500/15"
          }`}
        >
          <span
            className={error.fail ? "text-red-500" : "text-neutral-400 dark:text-neutral-500"}
          >
            {error.fail ? (
              <WarningTriangle className="h-7 w-7" />
            ) : (
              <XCircle className="h-7 w-7" />
            )}
          </span>
        </div>
        <div className="text-[18px] font-semibold text-neutral-900 dark:text-neutral-50">
          {error.title}
        </div>
        <div className="mt-2 text-[14px] leading-relaxed text-neutral-500 dark:text-neutral-400">
          {error.message}
        </div>

        {error.cmd && (
          <div className="mx-auto mt-5 max-w-[440px] overflow-x-auto rounded-xl border border-white/10 bg-neutral-900 px-4 py-3 text-left font-mono text-[12px] text-neutral-300 dark:bg-black/40">
            <span className="select-none text-neutral-500">$ </span>
            {error.cmd}
          </div>
        )}

        <div className="mt-7 flex items-center justify-center gap-2.5">
          <button
            onClick={ob.goHome}
            className="h-10 rounded-xl border border-black/10 px-4 text-[13.5px] font-medium text-neutral-600 hover:bg-black/5 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5"
          >
            Back to start
          </button>
          <button
            onClick={ob.retry}
            className="flex h-10 items-center gap-2 rounded-xl bg-[color:var(--accent)] px-5 text-[13.5px] font-semibold text-white shadow-sm hover:brightness-110"
          >
            <RetryIcon className="h-4 w-4" />
            {error.retryLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
