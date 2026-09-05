import type { RepoGraph } from "@/lib/api";
import { buildSquashMessage, getSquashEligibility } from "@/store/selection";
import { otherSquashTargets, type SquashTarget } from "@/store/squashTargets";
import type { PromptRequest } from "@/store/ui";
import type { MenuItem } from "@/components/chrome/overlays/shared";

interface SquashMenuOptions {
  graph: RepoGraph | null;
  shas: string[];
  branch: string | null;
  repoPath: string;
  requestPrompt: (request: PromptRequest) => void;
  submit: (message: string, target?: SquashTarget) => void;
}

export function squashMenuItems(options: SquashMenuOptions): MenuItem[] {
  const { graph, shas, branch, repoPath, requestPrompt, submit } = options;
  const squash = getSquashEligibility(graph, shas);
  const currentEligible = squash.ok && (squash.atTip || branch !== null);
  const targets: (SquashTarget | undefined)[] = currentEligible
    ? [undefined]
    : otherSquashTargets(graph, shas, branch, repoPath);
  return targets.map((target) => ({
    label: target
      ? `Squash ${shas.length} commits on ${target.branch}…`
      : `Squash ${shas.length} commits…`,
    onClick: () => requestPrompt({
      title: target
        ? `Squash ${shas.length} commits on ${target.branch}`
        : `Squash ${shas.length} commits into one`,
      message: target
        ? `The selected commits on "${target.branch}" are replaced by one commit; any commits above them are rewritten. Your current branch and uncommitted work stay unchanged. Commit hooks do not run for this rewrite.`
        : squash.atTip
          ? "The selected commits are replaced by one commit at the branch tip."
          : "The selected commits are replaced by one commit; the commits above them are rewritten onto it.",
      placeholder: "Subject\n\nDescription",
      defaultValue: buildSquashMessage(graph, shas),
      multiline: true,
      confirmLabel: "Squash",
      onSubmit: (message) => submit(message, target),
    }),
  }));
}
