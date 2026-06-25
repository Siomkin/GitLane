// The discussion area under a PR's description: the comment thread plus a
// composer that doubles as the review surface. "Comment" posts a discussion
// comment; "Approve" / "Request changes" submit a review (open PRs only) and are
// gated by a confirm dialog. All go through the pulls store.

import { useState } from "react";
import { cn } from "../../lib/cn";
import { initials, type PrComment, type PullRequest } from "../../lib/prs";
import { usePulls } from "../../store/pulls";
import { useUi } from "../../store/ui";
import { Markdown } from "@/components/ui/Markdown";
import { useRunPrAction } from "./usePrAction";

export function PrConversation({ pr }: { pr: PullRequest }) {
  return (
    <div>
      <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
        Conversation
      </div>
      {pr.commentList.length === 0 ? (
        <div className="rounded-xl border border-dashed border-black/15 px-4 py-8 text-center text-[13px] text-neutral-400 dark:border-white/15">
          No comments yet.
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {pr.commentList.map((c, i) => (
            <CommentCard key={i} comment={c} />
          ))}
        </div>
      )}
      {pr.state !== "merged" && <Composer pr={pr} />}
    </div>
  );
}

function CommentCard({ comment }: { comment: PrComment }) {
  return (
    <div className="rounded-xl border border-black/5 bg-white p-3.5 shadow-sm dark:border-white/10 dark:bg-neutral-800">
      <div className="mb-2 flex items-center gap-2.5">
        <span
          className="grid h-7 w-7 place-items-center rounded-md text-[11px] font-semibold text-white"
          style={{ background: "var(--accent)" }}
        >
          {initials(comment.author.name, comment.author.name)}
        </span>
        <span className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">
          {comment.author.name}
        </span>
        <span className="text-[12px] text-neutral-400">{comment.age}</span>
      </div>
      <Markdown content={comment.body} />
    </div>
  );
}

function Composer({ pr }: { pr: PullRequest }) {
  const commentPr = usePulls((s) => s.commentPr);
  const reviewPr = usePulls((s) => s.reviewPr);
  const pending = usePulls((s) => s.prPendingAction !== null);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const run = useRunPrAction();
  const [body, setBody] = useState("");
  const trimmed = body.trim();
  const isOpen = pr.state === "open";

  const after = (ok: boolean) => {
    if (ok) setBody("");
  };

  return (
    <div className="mt-2.5 overflow-hidden rounded-xl border border-black/10 bg-white shadow-sm transition-colors focus-within:border-[color:var(--accent)] dark:border-white/10 dark:bg-neutral-800">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Leave a comment…"
        className="h-24 w-full resize-none bg-transparent p-3.5 font-sans text-[13.5px] text-neutral-800 outline-none placeholder:text-neutral-400 dark:text-neutral-100"
      />
      <div className="flex items-center gap-2 border-t border-black/5 px-3 py-2.5 dark:border-white/5">
        <span className="text-[11px] text-neutral-400">Markdown supported</span>
        <div className="ml-auto flex items-center gap-2">
          {isOpen && (
            <>
              <button
                onClick={() =>
                  requestConfirm({
                    title: `Request changes on #${pr.num}?`,
                    message: "Your note will be posted as a changes-requested review.",
                    confirmLabel: "Request changes",
                    danger: true,
                    onConfirm: async () =>
                      after(await run(() => reviewPr(pr.num, "request-changes", body), `Requested changes on #${pr.num}`)),
                  })
                }
                disabled={pending || !trimmed}
                title={!trimmed ? "A note is required to request changes" : undefined}
                className={ghostBtn}
              >
                Request changes
              </button>
              <button
                onClick={() =>
                  requestConfirm({
                    title: `Approve #${pr.num}?`,
                    message: trimmed ? undefined : "Approve with no comment.",
                    confirmLabel: "Approve",
                    onConfirm: async () =>
                      after(await run(() => reviewPr(pr.num, "approve", body), `Approved #${pr.num}`)),
                  })
                }
                disabled={pending}
                className={cn(ghostBtn, "text-emerald-600 dark:text-emerald-400")}
              >
                Approve
              </button>
            </>
          )}
          <button
            onClick={async () => after(await run(() => commentPr(pr.num, body), "Comment posted"))}
            disabled={pending || !trimmed}
            className="h-8 rounded-lg bg-[var(--accent)] px-3.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
          >
            Comment
          </button>
        </div>
      </div>
    </div>
  );
}

const ghostBtn =
  "h-8 rounded-lg border border-black/10 px-3.5 text-[13px] font-medium text-neutral-700 hover:bg-black/5 disabled:opacity-45 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]";
