// Shared loading affordances. PR data comes from the `gh` CLI (network), which
// can take a few seconds, so these surface a clear spinner instead of a blank
// or misleading "empty" state.

import { cn } from "../../lib/cn";

export function Spinner({ className, accent = false }: { className?: string; accent?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block animate-spin rounded-full border-2",
        accent
          ? "border-[color:var(--accent-soft)] border-t-[color:var(--accent)]"
          : "border-black/10 border-t-neutral-500 dark:border-white/10 dark:border-t-neutral-400",
        className ?? "h-4 w-4",
      )}
    />
  );
}

export function Loading({ label, className }: { label: string; className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center justify-center gap-2.5 py-10 text-[12.5px] text-neutral-400",
        className,
      )}
    >
      <Spinner className="h-4 w-4" />
      <span>{label}</span>
    </div>
  );
}

/** A failed-load message with a Retry button. Used by the PR detail tabs so a
 * single resource's `gh` failure shows here (with a way to retry) instead of
 * sitting on a spinner forever or blanking the surrounding view. */
export function LoadError({
  message,
  onRetry,
  className,
}: {
  message: string;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 py-10 text-center text-[12.5px] text-neutral-400",
        className,
      )}
    >
      <span className="max-w-md whitespace-pre-wrap break-words">{message}</span>
      <button
        onClick={onRetry}
        className="rounded-md border border-black/10 px-2.5 py-1 text-[12px] font-medium text-neutral-700 hover:bg-black/5 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
      >
        Retry
      </button>
    </div>
  );
}
