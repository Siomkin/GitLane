// Shared "discard the whole working tree" action: preview the impact, confirm,
// then run the irreversible discard. Lives at the menus boundary module (the
// documented `api`-object import site, architecture-rules-react.md §1) so the
// destructive-preview read stays out of feature UI — both the WIP context menu
// and the changes-workspace header call this instead of duplicating the flow.

import { api } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useBranchOp } from "@/components/chrome/overlays/shared";
import { previewConfirm } from "./previewConfirm";

/** Returns a click handler that previews, confirms, and discards every
 * uncommitted change for the given repo. Callers own the disabled/guard state. */
export function useDiscardAllChanges(repoPath: string | null): () => void {
  const discardAll = useRepo((s) => s.discardAll);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const run = useBranchOp();
  return () =>
    void previewConfirm({
      requestConfirm,
      title: "Discard all changes?",
      message:
        "Every uncommitted change — staged, unstaged, and untracked files — will be permanently discarded. This can't be undone.",
      confirmLabel: "Discard all",
      danger: true,
      preview: () =>
        repoPath
          ? api.previewDiscardAll(repoPath)
          : Promise.reject(new Error("No repository")),
      onConfirm: () => void run(() => discardAll()),
    });
}
