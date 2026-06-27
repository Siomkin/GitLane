// The saved "Local comment" card, rendered under the line a note ends on.

import { MessageSquareIcon } from "@/components/ui/icons";

export const CommentCard = ({
  scope,
  body,
  onEdit,
  onDelete,
  indent = "ml-[100px] mr-3",
}: {
  scope: string;
  body: string;
  onEdit: () => void;
  onDelete: () => void;
  /** Left/right inset so the card aligns under the code (unified vs split gutter). */
  indent?: string;
}) => {
  return (
    <div
      className={`my-1.5 ${indent} w-[340px] max-w-full rounded-xl border border-black/10 bg-black/[0.03] p-3 dark:border-white/10 dark:bg-white/[0.04]`}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <span className="text-neutral-500 dark:text-neutral-400">
          <MessageSquareIcon width={12} height={12} strokeWidth={2} />
        </span>
        <span className="text-[11.5px] font-semibold text-neutral-700 dark:text-neutral-200">Local comment</span>
        <span className="ml-auto text-[10.5px] text-neutral-400">{scope}</span>
      </div>
      <div className="whitespace-pre-wrap break-words text-[13px] text-neutral-700 dark:text-neutral-200">{body}</div>
      <div className="mt-1.5 flex gap-3 text-[11.5px] font-medium">
        <button
          type="button"
          onClick={onEdit}
          className="text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-200"
        >
          Edit
        </button>
        <button type="button" onClick={onDelete} className="text-rose-500 hover:text-rose-600">
          Delete
        </button>
      </div>
    </div>
  );
};
