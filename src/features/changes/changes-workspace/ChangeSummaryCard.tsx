import { useMemo } from "react";
import type { WorkingChanges } from "@/lib/api";
import { AgentChangeDescription } from "@/features/changes/AgentChangeDescription";

export function ChangeSummaryCard({ changes }: { changes: WorkingChanges }) {
  // Watcher refreshes publish a new object even when only Git metadata changed.
  // Key on just the staged/unstaged/conflicted file buckets so the description
  // mailbox itself cannot cancel the poll that is waiting to consume it, and so
  // an advanced-state refresh (LFS/submodule/sparse) alone does not either.
  const changesKey = useMemo(
    () => JSON.stringify([changes.staged, changes.unstaged, changes.conflicted]),
    [changes.staged, changes.unstaged, changes.conflicted],
  );
  return (
    <AgentChangeDescription
      contextKey={`working:${changesKey}`}
      instruction={
        "Review all staged and unstaged changes in this repository. " +
        "Distinguish staged from unstaged work when that difference is meaningful."
      }
    />
  );
}
