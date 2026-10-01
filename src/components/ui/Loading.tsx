// Shared loading affordances. PR data comes from the `gh` CLI (network), which
// can take a few seconds, so these surface a clear spinner instead of a blank
// or misleading "empty" state.

import { cn } from "@/lib/cn";
import { ErrorFallback } from "./ErrorFallback";

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

/** A small in-button spinner that inherits the button's text colour via
 * `currentColor`, so it reads correctly on accent / danger / outline buttons
 * alike. Used to swap a PR action button's leading icon while its write is in
 * flight (the store's `prPendingActions` disables every sibling; this shows
 * *which* one is running). */
export function InlineSpinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block animate-spin rounded-full border-2 border-current border-t-transparent",
        className ?? "h-3.5 w-3.5",
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
export function LoadError(props: { message: string; onRetry: () => void; className?: string }) {
  return <ErrorFallback retryLabel="Retry" {...props} />;
}
