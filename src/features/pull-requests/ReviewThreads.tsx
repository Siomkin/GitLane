// Inline review threads for a PR — the file/line-anchored comments from the
// review, grouped by file, each resolvable. Mirrors GitHub's resolve / "Hide
// resolved" behaviour and the design's thread card (line/outdated/resolved
// badges, bot/author comment badges, a reply affordance, and a footer Resolve /
// Unresolve toggle). Threads + the resolve mutation come from the pulls store.
// The inline diff snippet (anchored hunk) is a planned follow-up.

import { useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/cn";
import { initials, relativeAge, type PullRequest } from "../../lib/prs";
import type { PrComment, ReviewThread } from "../../lib/api";
import { usePulls } from "../../store/pulls";
import { Markdown } from "@/components/ui/Markdown";
import { ReviewThreadControls } from "./ReviewThreadControls";
import { reviewThreadsModel } from "./reviewThreadsModel";

const isBot = (name: string) => name.toLowerCase().endsWith("[bot]");

export function ReviewThreads({ pr }: { pr: PullRequest }) {
  const threads = usePulls((s) => s.prThreads[pr.num]);
  const threadsError = usePulls((s) => s.prThreadsError[pr.num]);
  const loadPrThreads = usePulls((s) => s.loadPrThreads);
  const prsFetchedAt = usePulls((s) => s.prsFetchedAt);
  const [hideResolved, setHideResolved] = useState(true);

  useEffect(() => {
    void loadPrThreads(pr.num);
  }, [pr.num, prsFetchedAt, loadPrThreads]);

  // Memoized by the inputs that actually change it, so reply/pending rerenders
  // don't redo the filtering/grouping. Computed before the early returns —
  // hooks must run unconditionally.
  const model = useMemo(() => reviewThreadsModel(threads ?? [], hideResolved), [threads, hideResolved]);

  // Threads load automatically, so a failure here is the most visible: show an
  // inline retry rather than silently rendering nothing (and never touch the
  // PR list, which a shared error would have blanked).
  if (threadsError && !threads) {
    return (
      <div className="rounded-xl border border-dashed border-rose-300/50 px-4 py-5 text-center text-[12.5px] text-neutral-400 dark:border-rose-400/25">
        <div className="mb-2.5 whitespace-pre-wrap break-words">Couldn't load review threads.</div>
        <button
          onClick={() => void loadPrThreads(pr.num, true)}
          className="rounded-md border border-black/10 px-2.5 py-1 text-[12px] font-medium text-neutral-700 hover:bg-black/5 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!threads || threads.length === 0) return null;

  const { total, resolvedCount, allHidden, byFile } = model;

  return (
    <div>
      <div className="mb-3 flex items-center">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
          Review threads
        </span>
        <span className="ml-2 grid h-[18px] place-items-center rounded bg-black/[0.06] px-1.5 text-[10px] font-semibold text-neutral-500 dark:bg-white/10">
          {total}
        </span>
        {resolvedCount > 0 && (
          <button
            onClick={() => setHideResolved((h) => !h)}
            className="ml-auto rounded text-[12px] font-medium text-[color:var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
          >
            {hideResolved ? `Show resolved (${resolvedCount})` : "Hide resolved"}
          </button>
        )}
      </div>

      {allHidden ? (
        <div className="rounded-xl border border-dashed border-black/15 px-4 py-7 text-center text-[13px] text-neutral-400 dark:border-white/15">
          All {resolvedCount} thread{resolvedCount === 1 ? "" : "s"} resolved.
        </div>
      ) : (
        <div className="space-y-5">
          {byFile.map((group) => (
            <div key={group.path}>
              <div className="mb-2 truncate font-mono text-[12px] text-neutral-400">{group.path}</div>
              <div className="space-y-2.5">
                {group.threads.map((t) => (
                  <ThreadCard key={t.id} pr={pr} thread={t} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ThreadCard({ pr, thread }: { pr: PullRequest; thread: ReviewThread }) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border shadow-sm",
        thread.isResolved
          ? "border-black/5 bg-black/[0.02] dark:border-white/10 dark:bg-white/[0.02]"
          : "border-black/5 bg-white dark:border-white/10 dark:bg-neutral-800",
      )}
    >
      <div className="flex items-center gap-2 px-3.5 pb-2.5 pt-3">
        <span className="font-mono text-[11.5px] text-neutral-400">
          {thread.line != null ? `Line ${thread.line}` : "Original line"}
        </span>
        {thread.isOutdated && (
          <span className="grid h-5 place-items-center rounded bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-400/15 dark:text-amber-300">
            Outdated
          </span>
        )}
        {thread.isResolved && (
          <span className="flex h-5 items-center gap-1 rounded bg-purple-100 px-1.5 text-[10px] font-semibold text-purple-600 dark:bg-purple-400/15 dark:text-purple-300">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="h-2.5 w-2.5">
              <path d="M20 6 9 17l-5-5" />
            </svg>
            Resolved
          </span>
        )}
      </div>

      <div className="space-y-3.5 px-3.5 pb-1">
        {thread.comments.map((c, i) => (
          <ThreadComment key={i} comment={c} prAuthorName={pr.author.name} />
        ))}
        {thread.commentsTruncated && (
          <div className="text-[11.5px] italic text-neutral-400">
            This thread has more comments than shown here — open the pull request on GitHub to see all of them.
          </div>
        )}
      </div>

      <ReviewThreadControls prNum={pr.num} thread={thread} authorInitials={pr.author.initials} />
    </div>
  );
}

function ThreadComment({ comment, prAuthorName }: { comment: PrComment; prAuthorName: string }) {
  const name = comment.author.name || comment.author.login || "unknown";
  const bot = isBot(name) || isBot(comment.author.login);
  const isAuthor = name === prAuthorName;

  return (
    <div className="flex gap-2.5">
      {bot ? (
        <span className="grid h-6 w-6 flex-none place-items-center rounded-md bg-violet-500 text-white">
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5">
            <path d="M12 3l1.4 4.6L18 9l-4.6 1.4L12 15l-1.4-4.6L6 9l4.6-1.4z" />
          </svg>
        </span>
      ) : (
        <span
          className="grid h-6 w-6 flex-none place-items-center rounded-md text-[10px] font-semibold text-white"
          style={{ background: "var(--accent)" }}
        >
          {initials(name, name)}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">{name}</span>
          {bot && <Badge>Bot</Badge>}
          {isAuthor && <Badge>Author</Badge>}
          <span className="text-[11px] text-neutral-400">{relativeAge(comment.createdAt)}</span>
        </div>
        <div className="mt-1">
          <Markdown content={comment.body} />
        </div>
      </div>
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="grid h-[17px] place-items-center rounded border border-black/10 px-1.5 text-[10px] font-medium text-neutral-500 dark:border-white/15 dark:text-neutral-400">
      {children}
    </span>
  );
}
