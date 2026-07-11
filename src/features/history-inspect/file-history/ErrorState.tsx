export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-neutral-400">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-7 w-7 text-rose-400">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5M12 16h.01" />
      </svg>
      <p className="text-[13px] font-medium text-neutral-600 dark:text-neutral-300">Couldn't load history</p>
      <p className="max-w-full truncate text-[12px]">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-1 h-8 rounded-lg bg-[color:var(--accent)] px-3.5 text-[12px] font-semibold text-white hover:brightness-110"
      >
        Retry
      </button>
    </div>
  );
}

/** Shown when the walk finished and no commit ever touched the path. */
export function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-neutral-400">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-7 w-7">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
      </svg>
      <p className="text-[13px]">No commits changed this path.</p>
    </div>
  );
}
