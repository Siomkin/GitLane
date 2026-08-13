// Where an agent's answer goes once it arrives: into the Output pane, as the
// user's own editable resolution — never straight to disk.
//
// An answer that aligns onto the file's hunks becomes per-hunk state (ticks
// where the agent picked one side wholesale, custom text where it rewrote), so
// the user can still undo a single hunk. One that doesn't align becomes a
// whole-file rewrite, which the Output pane shows as one editor.

import type { ConflictResolver } from "@/features/conflicts/useConflictResolver";
import { alignProposal, picksForHunk } from "./proposalPicks";

/** Land one agent answer in the resolver, and switch to the pane that shows it. */
export function landProposal(
  resolver: Pick<
    ConflictResolver,
    "setFileResolution" | "setLineSelection" | "setCustomResolution" | "setMode"
  >,
  path: string,
  proposal: string,
  /** The conflicted body the answer was produced from (GL-180 staleness). */
  source: string,
): void {
  const hunks = alignProposal(source, proposal);
  if (!hunks) {
    resolver.setFileResolution(path, proposal, source);
  } else {
    for (const hunk of hunks) {
      const picks = picksForHunk(hunk);
      if (picks) resolver.setLineSelection(path, hunk.idx, picks);
      else resolver.setCustomResolution(path, hunk.idx, hunk.ai);
    }
  }
  resolver.setMode("split");
}
