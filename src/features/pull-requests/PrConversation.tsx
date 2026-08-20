// Read-only pull-request discussion plus the two surviving actions: bodyless
// approval and opening the provider page for authored collaboration.

import { ForgeKind } from "@/lib/api";
import { openExternalUrl } from "@/lib/openExternal";
import { initials, type PrComment, type PrDetail } from "@/lib/prs";
import { PR_PENDING_ACTION, anyPrActionPending, isPrActionPending, usePulls } from "@/store/pulls";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { Markdown } from "@/components/ui/Markdown";
import { InlineSpinner } from "@/components/ui/Loading";
import { prForgeOpenName } from "./prForgeOpen";
import { PR_ACTION_KEY, useKeyedPrAction } from "./usePrAction";

export function PrConversation({ pr }: { pr: PrDetail }) {
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
          {pr.commentList.map((comment, index) => (
            <CommentCard
              key={`${comment.author.login}:${comment.createdAt}:${index}`}
              comment={comment}
            />
          ))}
        </div>
      )}
      <ConversationActions pr={pr} />
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

function ConversationActions({ pr }: { pr: PrDetail }) {
  const approvePr = usePulls((s) => s.approvePr);
  const pending = usePulls(anyPrActionPending());
  const approvePending = usePulls(isPrActionPending(PR_PENDING_ACTION.Approve, pr.num));
  const forge = useRepo((s) => s.forge);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const showToast = useUi((s) => s.showToast);
  const { pendingKey, start } = useKeyedPrAction();
  const approving = pendingKey === PR_ACTION_KEY.Approve || approvePending;
  const forgeName = prForgeOpenName(forge?.kind, forge?.forge);
  const requestNoun = forge?.kind === ForgeKind.GitLab ? "MR" : "PR";

  const openOnProvider = () => {
    if (!pr.url) {
      showToast(`No ${forgeName} URL for this ${requestNoun}`, "error");
      return;
    }
    const accepted = openExternalUrl(pr.url, (error) =>
      showToast(`Could not open this ${requestNoun} on ${forgeName}: ${String(error)}`, "error"),
    );
    if (!accepted) showToast(`Invalid ${forgeName} URL for this ${requestNoun}`, "error");
  };

  return (
    <div className="mt-2.5 flex items-center justify-end gap-2">
      <button type="button" onClick={openOnProvider} className={ghostBtn}>
        Open on {forgeName}
      </button>
      {pr.state === "open" && (
        <button
          type="button"
          onClick={() =>
            requestConfirm({
              title: `Approve #${pr.num}?`,
              message: "Approve with no comment.",
              confirmLabel: "Approve",
              onConfirm: () => start(PR_ACTION_KEY.Approve, () => approvePr(pr.num)),
            })
          }
          disabled={pending}
          aria-busy={approving}
          className={`${ghostBtn} text-emerald-600 dark:text-emerald-400`}
        >
          {approving && <InlineSpinner className="h-3.5 w-3.5" />}
          {approving ? "Approving…" : "Approve"}
        </button>
      )}
    </div>
  );
}

const ghostBtn =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-black/10 px-3.5 text-[13px] font-medium text-neutral-700 hover:bg-black/5 disabled:opacity-45 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]";
