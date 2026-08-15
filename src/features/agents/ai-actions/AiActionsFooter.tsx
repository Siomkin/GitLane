import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import type { PrSummary } from "@/lib/prs";
import { AiActionView, type AiActionView as View } from "./aiActionsView";

const ghost =
  "h-9 shrink-0 whitespace-nowrap rounded-lg border border-black/10 bg-black/[0.03] px-3.5 text-[13px] font-medium text-neutral-600 hover:bg-black/[0.06] dark:border-white/[0.12] dark:bg-white/[0.05] dark:text-neutral-300 dark:hover:bg-white/[0.1]";
const posted =
  "h-9 shrink-0 whitespace-nowrap rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3.5 text-[13px] font-medium text-emerald-600 dark:text-emerald-400";

export function AiActionsFooter({
  statusLabel,
  view,
  copied,
  postedPr,
  posting,
  matchingPr,
  editing,
  onView,
  onCopy,
  onPost,
  onEdit,
}: {
  statusLabel: string;
  view: View;
  copied: boolean;
  postedPr: boolean;
  posting: boolean;
  matchingPr: PrSummary | undefined;
  editing: boolean;
  onView: (view: View) => void;
  onCopy: () => void;
  onPost: () => void;
  onEdit: () => void;
}) {
  return (
    <footer className="flex h-[60px] shrink-0 items-center gap-3 border-t border-black/[0.07] bg-black/[0.02] px-5 dark:border-white/[0.07] dark:bg-black/20">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
      <span className="min-w-0 truncate font-mono text-[12.5px] text-neutral-500 dark:text-neutral-400">
        {statusLabel}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <div className="flex shrink-0 rounded-md bg-black/[0.05] p-0.5 dark:bg-white/[0.06]">
          {([AiActionView.Formatted, AiActionView.Raw] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => onView(tab)}
              className={cn(
                "h-6 rounded px-2 text-[11.5px] font-medium whitespace-nowrap",
                view === tab
                  ? "bg-white text-neutral-800 shadow-sm dark:bg-neutral-700 dark:text-neutral-100"
                  : "text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200",
                focusRing,
              )}
            >
              {tab === AiActionView.Formatted ? "Formatted" : "Raw"}
            </button>
          ))}
        </div>
        <button type="button" onClick={onCopy} className={copied ? posted : ghost}>
          {copied ? "Copied" : "Copy"}
        </button>
        {matchingPr && (
          <button type="button" onClick={onPost} disabled={posting} className={postedPr ? posted : ghost}>
            {postedPr ? `Posted to PR #${matchingPr.num}` : "Post to PR"}
          </button>
        )}
        <button type="button" onClick={onEdit} className={editing ? posted : ghost}>
          {editing ? "Done editing" : "Edit"}
        </button>
      </div>
    </footer>
  );
}
