import { useUi } from "@/store/ui";
import { PersonAvatar } from "@/features/changes/CommitPeople";
import { relativeTime } from "@/lib/relativeTime";

/** The commit a history or blame inspector is showing. */
export interface CommitSummary {
  oid: string;
  shortOid: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  /** Unix seconds. */
  timestamp: number;
}

/** Short oid + Copy SHA, subject, and author with age: the head of the file
 * history's revision inspector and of the blame line inspector. Renders as a
 * fragment so it takes the parent's vertical rhythm. */
export function CommitSummaryCard({ commit }: { commit: CommitSummary }) {
  const overrides = useUi((s) => s.identityColors);
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[12px] text-neutral-400">{commit.shortOid}</span>
        <button
          type="button"
          onClick={() => void navigator.clipboard?.writeText(commit.oid)}
          className="h-7 rounded-md border border-black/10 px-2.5 text-[11.5px] font-medium text-neutral-600 hover:bg-black/5 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5"
        >
          Copy SHA
        </button>
      </div>
      <p className="text-pretty text-[14px] font-semibold leading-snug">{commit.subject || "(no subject)"}</p>
      <div className="flex items-center gap-2.5">
        <PersonAvatar
          person={{ name: commit.authorName, email: commit.authorEmail }}
          overrides={overrides}
          className="h-8 w-8 text-[11px]"
          iconClassName="h-5 w-5"
        />
        <div className="min-w-0">
          <div className="truncate text-[12.5px] font-medium">{commit.authorName}</div>
          <div className="text-[11px] text-neutral-400">{relativeTime(commit.timestamp, { long: true })}</div>
        </div>
      </div>
    </>
  );
}
