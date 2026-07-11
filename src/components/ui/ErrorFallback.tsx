import { cn } from "../../lib/cn";
import { focusRing } from "../../lib/ui";

/** Generic crash fallback rendered by an {@link ErrorBoundary}. Domain-free: it
 * takes a message and up to two actions, so a feature wraps its root in a
 * boundary and points the fallback's primary action at `reset`. Styled to match
 * `LoadError` (same tokens, dark-mode, focus ring) so a contained crash reads
 * like the rest of the app rather than a raw stack trace. */
export const ErrorFallback = ({
  message,
  onRetry,
  retryLabel = "Try again",
  secondary,
  className,
}: {
  message: string;
  onRetry: () => void;
  retryLabel?: string;
  /** Optional escape hatch beside retry, e.g. "Back to graph". */
  secondary?: { label: string; onClick: () => void };
  className?: string;
}) => {
  const button =
    "rounded-md border border-black/10 px-2.5 py-1 text-[12px] font-medium text-neutral-700 hover:bg-black/5 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5";
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-3 py-10 text-center text-[12.5px] text-neutral-400",
        className,
      )}
    >
      <span className="max-w-md whitespace-pre-wrap break-words">{message}</span>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onRetry} className={cn(button, focusRing)}>
          {retryLabel}
        </button>
        {secondary && (
          <button type="button" onClick={secondary.onClick} className={cn(button, focusRing)}>
            {secondary.label}
          </button>
        )}
      </div>
    </div>
  );
};
