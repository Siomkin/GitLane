import { api } from "@/lib/api";
import type { ForcePushPreview } from "@/lib/api";
import { previewConfirm } from "./previewConfirm";
import type { ConfirmFn } from "./previewConfirm";

/** Shared `--force-with-lease` preview/confirm used by the branch danger menu
 * and the action-bar Force push control. */
export function confirmLeasedForcePush({
  requestConfirm,
  repoPath,
  branch,
  forcePush,
  run,
}: {
  requestConfirm: ConfirmFn;
  repoPath: string | null;
  branch: string;
  forcePush: (branch: string, preview: ForcePushPreview) => Promise<string>;
  run: (op: () => Promise<string>) => void;
}): void {
  void previewConfirm({
    requestConfirm,
    title: `Force-push ${branch}?`,
    message:
      "Overwrites the remote branch with your local history (--force-with-lease: aborts if the remote moved since this preview). Use after amending or rebasing pushed commits.",
    confirmLabel: "Force push",
    danger: true,
    preview: () =>
      repoPath
        ? api.previewForcePush(repoPath, branch)
        : Promise.reject(new Error("No repository")),
    onConfirm: (impact) => void run(() => forcePush(branch, impact)),
  });
}
