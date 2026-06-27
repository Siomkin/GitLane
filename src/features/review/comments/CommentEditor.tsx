// The inline "Local comment" editor, rendered under the bottom line of the
// selected range. Indented past the two number gutters + sign column so it sits
// under the code, matching the diff body's left rail.

import { useEffect, useRef } from "react";
import { modEnter } from "../../../lib/platform";
import { MessageSquareIcon } from "@/components/ui/icons";
import type { LineCommentsController } from "./useLineComments";

export const CommentEditor = ({
  scope,
  controller,
  indent = "ml-[100px] mr-3",
}: {
  scope: string;
  controller: LineCommentsController;
  /** Left/right inset so the card aligns under the code (unified vs split gutter). */
  indent?: string;
}) => {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Focus once on open; re-focusing on every keystroke would fight the caret.
  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div
      className={`my-1.5 ${indent} rounded-xl border border-black/10 bg-black/[0.03] p-3 dark:border-white/10 dark:bg-white/[0.04]`}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-neutral-500/15 text-neutral-600 dark:text-neutral-300">
          <MessageSquareIcon width={14} height={14} />
        </span>
        <span className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">Local comment</span>
        <span className="ml-auto text-[12px] text-neutral-400">{scope}</span>
      </div>
      <textarea
        ref={ref}
        value={controller.draft}
        onChange={(e) => controller.setDraft(e.target.value)}
        onKeyDown={controller.onDraftKey}
        placeholder={`Request change…  (${modEnter} to comment · Esc to cancel)`}
        className="h-16 w-full resize-none bg-transparent text-[13px] text-neutral-700 outline-none placeholder:text-neutral-400 dark:text-neutral-200"
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={controller.cancel}
          className="h-8 rounded-lg px-3 text-[12px] font-medium text-neutral-500 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={controller.save}
          disabled={!controller.draft.trim()}
          className="h-8 rounded-lg bg-[color:var(--accent)] px-3 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-45"
        >
          Comment
        </button>
      </div>
    </div>
  );
};
