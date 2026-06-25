import { useState, type KeyboardEvent } from "react";
import type { ReviewThread } from "../../lib/api";
import { usePulls } from "../../store/pulls";
import { useRunPrAction } from "./usePrAction";

type PendingAction = "reply" | "resolve" | null;

interface ReviewThreadControlsProps {
  prNum: number;
  thread: ReviewThread;
  authorInitials: string;
}

export const ReviewThreadControls = ({ prNum, thread, authorInitials }: ReviewThreadControlsProps) => {
  const resolveThread = usePulls((s) => s.resolveThread);
  const replyThread = usePulls((s) => s.replyThread);
  const run = useRunPrAction();
  const [reply, setReply] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const trimmedReply = reply.trim();
  const pending = pendingAction != null;

  const toggleResolved = async () => {
    if (pending) return;
    setPendingAction("resolve");
    try {
      await run(
        () => resolveThread(prNum, thread.id, !thread.isResolved),
        thread.isResolved ? "Thread reopened" : "Thread resolved",
      );
    } finally {
      setPendingAction(null);
    }
  };

  const postReply = async () => {
    if (!trimmedReply || pending) return;
    setPendingAction("reply");
    try {
      const ok = await run(
        () => replyThread(prNum, thread.id, trimmedReply),
        "Reply posted",
      );
      if (ok) setReply("");
    } finally {
      setPendingAction(null);
    }
  };

  // Enter inserts a newline; ⌘/Ctrl+Enter posts — the GitHub-web convention.
  const onReplyKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void postReply();
    }
  };

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void postReply();
        }}
        className="flex items-center gap-2.5 px-3.5 py-3"
      >
        <span
          className="grid h-6 w-6 flex-none place-items-center rounded-md text-[10px] font-semibold text-white"
          style={{ background: "var(--accent)" }}
        >
          {authorInitials}
        </span>
        <textarea
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={onReplyKeyDown}
          aria-label="Reply to review thread"
          placeholder="Reply..."
          rows={1}
          disabled={pending}
          className="min-h-9 flex-1 resize-none rounded-lg border border-black/10 bg-transparent px-3 py-2 text-[13px] leading-5 text-neutral-800 outline-none placeholder:text-neutral-400 disabled:opacity-60 focus:border-[color:var(--accent)] dark:border-white/10 dark:text-neutral-100"
        />
        {trimmedReply && (
          <button
            type="submit"
            disabled={pending}
            className="h-9 rounded-lg bg-[var(--accent)] px-3 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
          >
            Reply
          </button>
        )}
      </form>

      <div className="flex items-center gap-3 border-t border-black/5 bg-black/[0.015] px-3.5 py-2.5 dark:border-white/5 dark:bg-white/[0.02]">
        <button
          onClick={toggleResolved}
          disabled={pending}
          className="rounded-md border border-black/10 px-2.5 py-1 text-[11.5px] font-medium text-neutral-700 hover:bg-black/5 disabled:opacity-45 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
        >
          {thread.isResolved ? "Unresolve conversation" : "Resolve conversation"}
        </button>
        {thread.isResolved && (
          <span className="truncate text-[12px] text-neutral-400">This conversation is resolved.</span>
        )}
      </div>
    </>
  );
};
