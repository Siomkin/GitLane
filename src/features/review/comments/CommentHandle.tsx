// The right-rail (30px column) affordance per diff line: a grab handle to start
// a comment selection, or — once a note ends on this line — a marker that
// toggles the saved card.

import { cn } from "@/lib/cn";
import { MessageSquareIcon } from "@/components/ui/icons";
import type { LineRowComments } from "./useLineComments";

export const CommentHandle = ({ row }: { row: LineRowComments }) => {
  if (row.showHandle) {
    return (
      <button
        type="button"
        onMouseDown={row.onHandleDown}
        title="Click, or drag down, to comment on line(s)"
        aria-label="Comment on line(s)"
        className="grid h-[18px] w-[18px] cursor-pointer place-items-center rounded-md bg-neutral-500/15 text-neutral-600 opacity-0 transition hover:bg-neutral-500/25 focus:opacity-100 group-hover/line:opacity-100 dark:text-neutral-300"
      >
        <MessageSquareIcon width={10} height={10} strokeWidth={2} />
      </button>
    );
  }
  if (row.isAnchor) {
    return (
      <button
        type="button"
        onClick={row.toggleCard}
        title="Toggle comment"
        aria-label="Toggle comment"
        className={cn(
          "grid h-[18px] w-[18px] place-items-center rounded-md text-neutral-500 transition-colors dark:text-neutral-400",
          row.cardOpen ? "bg-neutral-500/25 ring-1 ring-neutral-400" : "bg-neutral-500/15 hover:bg-neutral-500/25",
        )}
      >
        <MessageSquareIcon width={10} height={10} strokeWidth={2} />
      </button>
    );
  }
  return null;
};
