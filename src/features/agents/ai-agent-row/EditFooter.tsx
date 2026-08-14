// The expanded row's Save / Cancel / Remove footer.

import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";

/** Closing an expanded row was only ever the header/menu "Done", which nothing
 *  on screen said — so the panel names its three exits itself. Save stays
 *  disabled until this row differs from disk. */
export function EditFooter({
  label,
  saveDisabled,
  saving,
  onSave,
  onCancel,
  onDelete,
}: {
  label: string;
  saveDisabled: boolean;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="mt-3 flex items-center gap-2 border-t border-black/[0.05] pt-2.5 dark:border-white/[0.06]">
      <button
        type="button"
        aria-label={`Save ${label}`}
        disabled={saveDisabled}
        onClick={onSave}
        className={cn(
          "h-8 rounded-lg bg-[var(--accent)] px-3.5 text-[13px] font-semibold text-white shadow-sm transition hover:brightness-110 active:scale-[0.97] disabled:cursor-default disabled:opacity-45 disabled:hover:brightness-100 disabled:active:scale-100",
          focusRing,
        )}
      >
        {saving ? "Saving…" : "Save"}
      </button>
      <button
        type="button"
        aria-label={`Cancel ${label}`}
        onClick={onCancel}
        title="Discard the edits made since this row was opened"
        className={cn(
          "h-8 rounded-lg px-3 text-[13px] text-neutral-500 hover:bg-black/[0.05] dark:text-neutral-400 dark:hover:bg-white/[0.07]",
          focusRing,
        )}
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onDelete}
        className={cn(
          "ml-auto h-8 rounded-lg px-3 text-[13px] font-semibold text-rose-600 hover:bg-rose-500/10 dark:text-rose-400",
          focusRing,
        )}
      >
        Remove agent
      </button>
    </div>
  );
}
