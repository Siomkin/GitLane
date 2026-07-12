import { cn } from "../../lib/cn";

type Mode = "history" | "blame" | "compare";

/** Shared breadcrumb header for every inspection mode: a "Commits" back crumb,
 * a mode title, the repo-relative path (file modes only) with copy, the
 * History/Blame sub-toggle (file modes only), and a close button. */
export function InspectHeader({
  mode,
  title,
  path,
  onBack,
  onCopyPath,
  onHistory,
  onBlame,
}: {
  mode: Mode;
  title: string;
  path?: string;
  onBack: () => void;
  onCopyPath?: () => void;
  onHistory?: () => void;
  onBlame?: () => void;
}) {
  const showPath = mode !== "compare" && !!path;
  const showSub = mode === "history" || mode === "blame";

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-black/5 px-3 dark:border-white/5">
      <button type="button"
        onClick={onBack}
        className="flex h-8 items-center gap-1 rounded-lg pl-1.5 pr-2.5 text-[12px] font-medium text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
          <path d="m15 18-6-6 6-6" />
        </svg>
        Commits
      </button>
      <span className="text-neutral-300 dark:text-neutral-600">/</span>
      {mode === "compare" ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-4 w-4 shrink-0 text-neutral-400">
          <path d="M7 7h10M7 7l3-3M7 7l3 3M17 17H7M17 17l-3-3M17 17l-3 3" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-4 w-4 shrink-0 text-neutral-400">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v4l3 2" />
        </svg>
      )}
      <span className="shrink-0 text-[13px] font-semibold">{title}</span>
      {showPath && (
        <>
          <span className="min-w-0 truncate font-mono text-[12px] text-neutral-400">{path}</span>
          <button type="button"
            onClick={onCopyPath}
            title="Copy path"
            aria-label="Copy path"
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-black/5 dark:hover:bg-white/5"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3.5 w-3.5">
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15V5a2 2 0 0 1 2-2h10" />
            </svg>
          </button>
        </>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {showSub && (
          <div className="flex rounded-lg bg-black/[0.06] p-0.5 text-[12px] dark:bg-white/[0.06]">
            <button type="button" className={subButton(mode === "history")} onClick={onHistory}>
              History
            </button>
            <button type="button" className={subButton(mode === "blame")} onClick={onBlame}>
              Blame
            </button>
          </div>
        )}
        <button type="button"
          onClick={onBack}
          title="Close"
          aria-label="Close"
          className="grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-black/5 dark:hover:bg-white/5"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

const subButton = (active: boolean) =>
  cn(
    "h-6 rounded-md px-2.5",
    active
      ? "bg-white font-medium text-neutral-800 shadow-sm dark:bg-neutral-700 dark:text-neutral-100"
      : "text-neutral-500 dark:text-neutral-400",
  );
