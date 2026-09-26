// PR detail header action cluster (right side of the meta row): the forge
// link, then the state actions — Reopen / Ready (PrLifecycleControls), the
// Merge split-button (PrMergeMenu), and secondary actions in a "..." overflow
// menu (PrMoreMenu). Write actions are gated by a confirm dialog and toast
// gh's result. Split per surface in GL-187; this file stays the public
// composer that derives the provider capabilities.

import { prCapabilities } from "@/lib/forgeHelp";
import type { PrSummary } from "@/lib/prs";
import { useRepo } from "@/store/repo";
import { PrLifecycleControls } from "./PrLifecycleControls";
import { PrMergeMenu } from "./PrMergeMenu";
import { PrMoreMenu } from "./PrMoreMenu";
import { PrForgeIcon, useOpenPrOnForge } from "./prForgeOpen";
import { utilBtn } from "./prActionStyles";

/** The full right-side action cluster for the PR detail header. Every flag is
 * read from the forge's declared capabilities: a forge without rebase-merge
 * gets the basic merge menu, and only forges that declare state actions show
 * close/reopen/ready. A null forge is the GitHub default the PR surface renders
 * under before detection resolves. */
export const PrHeaderActions = ({ pr }: { pr: PrSummary }) => {
  const forge = useRepo((s) => s.forge);
  const { open: openOnForge, forgeName } = useOpenPrOnForge(pr);
  const caps = prCapabilities(forge);
  const basicMerge = !caps?.mergeMethods.includes("rebase");
  const canManageState = (caps?.stateActions.length ?? 0) > 0;
  const hasStateActions = pr.state !== "merged" && canManageState;

  return (
    <div className="ml-auto flex flex-none items-center gap-2">
      <button type="button"
        title={`Open on ${forgeName}`}
        aria-label={`Open on ${forgeName}`}
        onClick={openOnForge}
        className={utilBtn}
      >
        <PrForgeIcon kind={forge?.kind} className="h-4 w-4" />
      </button>
      {hasStateActions && <span className="mx-0.5 h-5 w-px bg-black/10 dark:bg-white/10" />}
      {hasStateActions && <PrLifecycleControls pr={pr} />}
      {pr.state === "open" && !pr.draft && (
        <PrMergeMenu pr={pr} basic={basicMerge} allowDeleteBranch={caps?.deleteBranch === true} />
      )}
      <PrMoreMenu pr={pr} canClose={canManageState} />
    </div>
  );
};
