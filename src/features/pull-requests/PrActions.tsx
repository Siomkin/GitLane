// PR detail header action cluster (right side of the meta row): the forge
// link, then the state actions — Reopen / Ready (PrLifecycleControls), the
// Merge split-button (PrMergeMenu), and secondary actions in a "..." overflow
// menu (PrMoreMenu). Write actions are gated by a confirm dialog and toast
// gh's result. Split per surface in GL-187; this file stays the public
// composer that derives the provider capabilities.

import { openExternalUrl } from "../../lib/openExternal";
import { ForgeKind } from "../../lib/api";
import type { PullRequest } from "../../lib/prs";
import { useRepo } from "../../store/repo";
import { useUi } from "../../store/ui";
import { BitbucketIcon, GitHubIcon, GitLabIcon } from "@/components/ui/icons";
import { PrLifecycleControls } from "./PrLifecycleControls";
import { PrMergeMenu } from "./PrMergeMenu";
import { PrMoreMenu } from "./PrMoreMenu";
import { utilBtn } from "./prActionStyles";

/** The full right-side action cluster for the PR detail header. GitLab (GL-145)
 * and Bitbucket (GL-141) are "basic" providers: the external link + icon follow
 * the forge, "Rebase and merge" is dropped (neither has a rebase-merge endpoint),
 * and the close/reopen/ready lifecycle actions are hidden — those aren't
 * implemented for GitLab MRs / Bitbucket PRs. Bitbucket keeps the "PR" noun. */
export const PrHeaderActions = ({ pr }: { pr: PullRequest }) => {
  const showToast = useUi((s) => s.showToast);
  const forge = useRepo((s) => s.forge);
  const isGitlab = forge?.kind === ForgeKind.GitLab;
  const isBitbucket = forge?.kind === ForgeKind.Bitbucket;
  // "Basic" PR providers: approve + merge (no rebase) + create, no lifecycle.
  const basic = isGitlab || isBitbucket;
  const forgeName = forge?.forge ?? "the remote";
  const ForgeIcon = isGitlab ? GitLabIcon : isBitbucket ? BitbucketIcon : GitHubIcon;
  const requestNoun = isGitlab ? "MR" : "PR";
  // Lifecycle (reopen/ready/close) is GitHub-only until the basic providers grow it.
  const hasStateActions = pr.state !== "merged" && !basic;

  return (
    <div className="ml-auto flex flex-none items-center gap-2">
      <button type="button"
        title={`Open on ${forgeName}`}
        onClick={() => {
          if (pr.url) openExternalUrl(pr.url);
          else showToast(`No ${forgeName} URL for this ${requestNoun}`, "error");
        }}
        className={utilBtn}
      >
        <ForgeIcon className="h-4 w-4" />
      </button>
      {hasStateActions && <span className="mx-0.5 h-5 w-px bg-black/10 dark:bg-white/10" />}
      {hasStateActions && <PrLifecycleControls pr={pr} />}
      {pr.state === "open" && !pr.draft && <PrMergeMenu pr={pr} basic={basic} />}
      <PrMoreMenu pr={pr} basic={basic} />
    </div>
  );
};
