import { WarningIcon } from "@/components/ui/icons";

/** The degraded state of a navigator section whose last read failed (GL
 * unify-error-model): the section keeps its last good rows above/below this
 * one, and this row says why the list may be stale instead of the section
 * silently reading as empty. Static — nothing to click; the message is the
 * store's error text, shown as the tooltip. */
export function UnavailableRow({ noun, message }: { noun: string; message: string }) {
  return (
    <div
      role="status"
      title={message}
      className="flex h-8 items-center gap-2 rounded-lg px-2 text-[12px] text-amber-700 dark:text-amber-300"
    >
      <WarningIcon className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">Couldn't read {noun}</span>
    </div>
  );
}
