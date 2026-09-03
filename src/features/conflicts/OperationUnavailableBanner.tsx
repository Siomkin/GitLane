import { WarningIcon } from "@/components/ui/icons";

/** A slim banner for a refresh whose operation-status read failed: the last
 * known merge/rebase state is kept (the conflict workspace stays up while
 * conflicts remain) and this says so, instead of the app silently reporting
 * "no operation in progress". Clears itself on the next successful read —
 * the store drops the `operation` flag, so the banner unmounts. */
export const OperationUnavailableBanner = ({ message }: { message: string }) => (
  <div
    role="status"
    className="mb-2.5 flex items-center gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-1.5 dark:border-amber-400/20 dark:bg-amber-400/[0.08]"
  >
    <div className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-amber-400/20 text-amber-600 dark:text-amber-300">
      <WarningIcon className="h-4 w-4" />
    </div>
    <div className="flex min-w-0 flex-1 items-baseline gap-2">
      <span className="shrink-0 truncate text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">
        Couldn't read the operation status
      </span>
      <span className="truncate text-[12px] text-neutral-500 dark:text-neutral-400" title={message}>
        {message}
      </span>
    </div>
    <span className="grid h-5 shrink-0 place-items-center rounded-md bg-amber-400/20 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
      Unavailable
    </span>
  </div>
);
