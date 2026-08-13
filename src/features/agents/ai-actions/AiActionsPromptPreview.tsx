import { useState } from "react";
import { ChevronDownIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";

/** The Settings prompt for the selected action, collapsed until asked. Edit
 *  jumps to Settings → Prompts rather than turning this row into an editor. */
export function AiActionsPromptPreview({
  instruction,
  onEdit,
}: {
  instruction: string;
  onEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="shrink-0 border-b border-black/[0.07] bg-black/[0.02] px-4 py-1.5 dark:border-white/[0.07] dark:bg-black/20">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            "flex h-7 items-center gap-1 rounded-md px-1.5 text-[12px] text-neutral-500 hover:bg-black/[0.05] hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-white/[0.06] dark:hover:text-neutral-200",
            focusRing,
          )}
        >
          <ChevronDownIcon className={cn("h-3 w-3 transition-transform", !open && "-rotate-90")} />
          {open ? "Hide prompt" : "Show prompt"}
        </button>
        <button
          type="button"
          onClick={onEdit}
          className={cn(
            "ml-auto h-7 rounded-md px-1.5 text-[12px] font-medium text-[color:var(--accent)] hover:bg-[var(--accent-soft)]",
            focusRing,
          )}
        >
          Edit in Settings
        </button>
      </div>
      {open && (
        <pre className="mt-1.5 max-h-[160px] overflow-y-auto whitespace-pre-wrap rounded-lg border border-black/[0.06] bg-white px-3 py-2 font-mono text-[12px] leading-5 text-neutral-600 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-neutral-300">
          {instruction}
        </pre>
      )}
    </div>
  );
}
