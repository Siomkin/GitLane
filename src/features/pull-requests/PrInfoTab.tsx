// PR Info tab: the stat line (state · files · comments · diff), metadata,
// description, review threads, and conversation. Reads entirely from the cached
// PR detail it's handed — no fetching of its own.
import { cn } from "@/lib/cn";
import type { PrStack } from "@/lib/api";
import type { PrDetail } from "@/lib/prs";
import { Markdown } from "@/components/ui/Markdown";
import { PrConversation } from "./PrConversation";
import { ReviewThreads } from "./ReviewThreads";
import { PrMeta } from "./PrMeta";
import { PrStackCard } from "./pr-stack";
import { stateView } from "./prState";

export function PrInfoTab({ pr, stack }: { pr: PrDetail; stack?: PrStack | null }) {
  const sv = stateView(pr);
  return (
    <div className="space-y-6">
      {/* Compact stat line: state · Files · Comments · (right) Diff. */}
      <div className="flex h-11 items-center gap-4 rounded-xl bg-black/[0.03] px-3.5 text-[13px] dark:bg-white/[0.04]">
        <span className={cn("flex items-center gap-1.5 font-medium", sv.text)}>
          <span className={cn("h-1.5 w-1.5 rounded-full", sv.dot)} />
          {sv.label}
        </span>
        <span className="h-4 w-px bg-black/10 dark:bg-white/10" />
        <span className="flex items-center gap-1.5">
          <span className="text-neutral-400">Files</span>
          <span className="font-semibold text-neutral-800 dark:text-neutral-100">{pr.files.length}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-neutral-400">Comments</span>
          <span className="font-semibold text-neutral-800 dark:text-neutral-100">{pr.comments}</span>
        </span>
        <span className="ml-auto flex items-center gap-1.5 font-mono">
          <span className="font-sans text-neutral-400">Diff</span>
          <span className="text-[color:var(--accent)]">+{pr.add}</span>
          <span className="text-rose-500">−{pr.del}</span>
        </span>
      </div>
      {stack && <PrStackCard stack={stack} pr={pr} />}
      <PrMeta pr={pr} />
      <div>
        <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
          Description
        </div>
        {pr.body.trim() ? (
          <Markdown content={pr.body} />
        ) : (
          <div className="text-[12.5px] italic text-neutral-400">No description provided.</div>
        )}
      </div>
      <ReviewThreads pr={pr} />
      <PrConversation pr={pr} />
    </div>
  );
}
