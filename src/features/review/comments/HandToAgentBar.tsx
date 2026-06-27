// Docked footer shown under a diff when local comments exist: summarises the
// pending comments and opens the "hand to agent" message composer. Replaces the
// old floating notes tray — it lives at the bottom of the review surface.

import { useRepo } from "../../../store/repo";
import { useUi } from "../../../store/ui";
import { DiamondIcon } from "@/components/ui/icons";

export const HandToAgentBar = ({
  surfaces,
  branch: branchOverride,
}: {
  /** The review surface(s) whose comments this bar summarises + hands off (the
   * working review passes both staged + unstaged). */
  surfaces: string[];
  /** Branch named in the hand-off message; defaults to the checked-out branch
   * (PR diffs pass the PR's head branch instead). */
  branch?: string | null;
}) => {
  const notes = useUi((s) => s.reviewNotes);
  const openAgentMessage = useUi((s) => s.openAgentMessage);
  const headBranch = useRepo((s) => s.summary?.headBranch ?? null);
  const branch = branchOverride ?? headBranch;

  const n = notes.reduce((count, note) => (surfaces.includes(note.surface) ? count + 1 : count), 0);
  if (n === 0) return null;
  const word = n === 1 ? "comment" : "comments";

  return (
    <div className="sticky bottom-0 z-10 flex flex-none items-center gap-2.5 border-t border-black/5 bg-white p-3 dark:border-white/5 dark:bg-neutral-800">
      <span className="flex flex-none items-center gap-1.5 text-[13px] font-semibold text-neutral-700 dark:text-neutral-200">
        <DiamondIcon width={14} height={14} className="text-neutral-500" />
        Hand to agent
        <span className="grid h-4 min-w-[16px] place-items-center rounded-full bg-neutral-500 px-1 text-[10px] font-semibold text-white">
          {n}
        </span>
      </span>
      <div className="min-w-0 flex-1 truncate text-[12px] text-neutral-500 dark:text-neutral-400">
        {n} {word}
        {branch ? ` · branch ${branch}` : ""}
      </div>
      <button
        type="button"
        onClick={() => openAgentMessage(surfaces, branch)}
        className="h-9 flex-none rounded-lg bg-[color:var(--accent)] px-4 text-[13px] font-semibold text-white hover:brightness-110"
      >
        Prepare message for agent
      </button>
    </div>
  );
};
