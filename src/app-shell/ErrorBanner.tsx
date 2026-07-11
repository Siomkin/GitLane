import { useRepo } from "../store/repo";

/** The global repo-error bar under the title bar: store actions that fail
 * outside a dedicated surface (open, refresh, graph reads) publish one
 * dismissable message here. */
export const ErrorBanner = () => {
  const error = useRepo((state) => state.error);
  const clearError = useRepo((state) => state.clearError);
  if (!error) return null;
  return (
    <div className="mx-2.5 mb-2.5 flex items-center justify-between gap-3 rounded-xl border border-rose-300 bg-rose-50 px-3.5 py-2 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
      <span>{error}</span>
      <button type="button"
        className="h-7 shrink-0 rounded-lg border border-black/10 px-3 text-[12px] font-medium hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
        onClick={clearError}
      >
        Dismiss
      </button>
    </div>
  );
};
