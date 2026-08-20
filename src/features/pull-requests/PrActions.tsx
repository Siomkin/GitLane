// PR detail header action cluster (right side of the meta row): the forge
// link, then the state actions — Reopen / Ready (PrLifecycleControls), the
// Merge split-button (PrMergeMenu), and secondary actions in a "..." overflow
// menu (PrMoreMenu). Write actions are gated by a confirm dialog and toast
// gh's result. Split per surface in GL-187; this file stays the public
// composer that derives the provider capabilities.

import { openExternalUrl } from "@/lib/openExternal";
import { ForgeKind } from "@/lib/api";
import type { PrSummary } from "@/lib/prs";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { PrLifecycleControls } from "./PrLifecycleControls";
import { PrMergeMenu } from "./PrMergeMenu";
import { PrMoreMenu } from "./PrMoreMenu";
import { PrForgeIcon, prForgeOpenName } from "./prForgeOpen";
import { utilBtn } from "./prActionStyles";

/** The full right-side action cluster for the PR detail header. GitLab (GL-145),
 * Bitbucket (GL-141), and Cursor Origin use the basic merge menu without rebase;
 * Origin additionally supports the shared close/reopen/ready controls. */
export const PrHeaderActions = ({ pr }: { pr: PrSummary }) => {
  const showToast = useUi((s) => s.showToast);
  const forge = useRepo((s) => s.forge);
  const isGitlab = forge?.kind === ForgeKind.GitLab;
  const isBitbucket = forge?.kind === ForgeKind.Bitbucket;
  const isOrigin = forge?.kind === ForgeKind.CursorOrigin;
  const basicMerge = isGitlab || isBitbucket || isOrigin;
  // Allow-list, not a deny-list: only forges whose provider implements
  // `set_pr_state` may show close/reopen/ready. A null forge is the GitHub
  // default the PR surface renders under before detection resolves.
  const canManageState = forge == null || forge.kind === ForgeKind.GitHub || isOrigin;
  const forgeName = prForgeOpenName(forge?.kind, forge?.forge);
  const requestNoun = isGitlab ? "MR" : "PR";
  const hasStateActions = pr.state !== "merged" && canManageState;

  return (
    <div className="ml-auto flex flex-none items-center gap-2">
      <button type="button"
        title={`Open on ${forgeName}`}
        aria-label={`Open on ${forgeName}`}
        onClick={() => {
          if (!pr.url) {
            showToast(`No ${forgeName} URL for this ${requestNoun}`, "error");
            return;
          }
          const accepted = openExternalUrl(pr.url, (error) =>
            showToast(`Could not open this ${requestNoun} on ${forgeName}: ${String(error)}`, "error"),
          );
          if (!accepted) {
            showToast(`Invalid ${forgeName} URL for this ${requestNoun}`, "error");
          }
        }}
        className={utilBtn}
      >
        <PrForgeIcon kind={forge?.kind} className="h-4 w-4" />
      </button>
      {hasStateActions && <span className="mx-0.5 h-5 w-px bg-black/10 dark:bg-white/10" />}
      {hasStateActions && <PrLifecycleControls pr={pr} />}
      {pr.state === "open" && !pr.draft && (
        <PrMergeMenu pr={pr} basic={basicMerge} allowDeleteBranch={!isOrigin} />
      )}
      <PrMoreMenu pr={pr} canClose={canManageState} />
    </div>
  );
};
