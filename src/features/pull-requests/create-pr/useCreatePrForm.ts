// All state and derivation for the create-PR dialog, so the components below it
// stay presentational. Owns the target mode, the description draft and its undo,
// reviewer selection, and the submit that closes the dialog.

import { useEffect, useMemo, useState } from "react";
import { BranchKind, ForgeKind, type BranchInfo, type PrReviewerCandidate } from "@/lib/api";
import { useAccounts } from "@/store/accounts";
import { PR_PENDING_ACTION, usePulls } from "@/store/pulls";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useRunPrAction } from "@/features/pull-requests/usePrAction";
import { bodyFromCommits, type PrTemplateRef } from "./prTemplates";
import {
  mergeOrderNote,
  stackCandidates,
  stackChain,
  stackMapRows,
  stackParent,
} from "./prTargets";
import { readTemplate, useAncestorRefs, usePrTemplates, useRangeRead } from "./useCreatePrReads";

/** Which editor pane the description shows. */
export const DESCRIPTION_TAB = { Write: "write", Preview: "preview" } as const;
export type DescriptionTab = (typeof DESCRIPTION_TAB)[keyof typeof DESCRIPTION_TAB];

/** Conventional default branches, best-guess order, when nothing else says. */
const DEFAULT_BASE_GUESSES = ["main", "develop", "master"];

export function useCreatePrForm() {
  const close = useUi((s) => s.closeCreatePr);
  const dialogGeneration = useUi((s) => s.createPrGeneration);
  const summary = useRepo((s) => s.summary);
  const branches = useRepo((s) => s.branches);
  const forge = useRepo((s) => s.forge);
  const openPrs = usePulls((s) => s.pullRequests);
  const createPr = usePulls((s) => s.createPr);
  const loadReviewerCandidates = usePulls((s) => s.loadReviewerCandidates);
  const pending = usePulls((s) => s.prPendingActions.length > 0);
  const creating = usePulls((s) =>
    s.prPendingActions.some((entry) => entry.action === PR_PENDING_ACTION.Create),
  );
  const prAccount = useAccounts((s) => s.prAccountRef());
  const run = useRunPrAction();

  const repoPath = summary?.path ?? null;
  const head = summary?.headBranch ?? "";
  const branchNames = useMemo(() => baseCandidates(branches, head), [branches, head]);
  const defaultBase = useMemo(() => guessBase(branchNames, head), [branchNames, head]);

  const [stackMode, setStackMode] = useState(false);
  const [base, setBase] = useState(defaultBase);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tab, setTab] = useState<DescriptionTab>(DESCRIPTION_TAB.Write);
  const [draft, setDraft] = useState(false);
  const [reviewers, setReviewers] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<PrReviewerCandidate[]>([]);
  // The description before "From commits" or a template replaced it. Null when
  // there is nothing to restore, which is also what hides the undo button.
  const [replacedBody, setReplacedBody] = useState<string | null>(null);

  // Stacking is a GitHub concept and only holds inside one repository. A forge
  // we haven't identified yet is treated as not-GitHub rather than optimistically
  // offering a tab that may vanish — a control that appears and disappears while
  // the dialog is open is worse than one that arrives once.
  const stackingSupported = forge?.kind === ForgeKind.GitHub;
  const remote = useMemo(() => branchRemote(branches, head), [branches, head]);
  const byRef = useMemo(
    () => stackCandidates(openPrs, remote, head),
    [openPrs, remote, head],
  );
  const ancestors = useAncestorRefs(
    repoPath,
    head,
    useMemo(() => [...byRef.keys()], [byRef]),
    stackingSupported,
  );
  const parent = useMemo(() => stackParent(ancestors, byRef), [ancestors, byRef]);
  const canStack = stackingSupported && parent !== null;
  const stacked = canStack && stackMode;

  // Two spellings of the same target, deliberately kept apart. `targetRef` is
  // what git resolves locally and may be a remote-tracking ref; `targetBranch`
  // is the branch name the forge is told, because a pull request targets a
  // branch. Conflating them opens pull requests against "origin/develop".
  const targetRef = stacked && parent ? parent.ref : base;
  const targetBranch = stacked && parent ? parent.pr.branch : branchNameOf(branches, base);
  const range = useRangeRead(repoPath, targetRef, head);
  const templates = usePrTemplates(repoPath);

  const chain = useMemo(
    () => (stacked && parent ? stackChain(parent.pr, openPrs) : []),
    [stacked, parent, openPrs],
  );
  const mapRows = useMemo(
    () =>
      stackMapRows({
        head,
        chain,
        trunk: chain.length > 0 ? chain[chain.length - 1].base : targetBranch,
        commitCount: range.commits.length,
        createdNumber: null,
      }),
    [head, chain, targetBranch, range.commits.length],
  );

  useEffect(() => {
    let alive = true;
    void loadReviewerCandidates().then((found) => {
      if (alive) setCandidates(found);
    });
    return () => {
      alive = false;
    };
  }, [loadReviewerCandidates]);

  const applyBody = (next: string) => {
    setReplacedBody(body);
    setBody(next);
    setTab(DESCRIPTION_TAB.Write);
  };

  const canSubmit = !!title.trim() && !!targetBranch && !!head && targetBranch !== head;
  const closeCurrent = () => close(dialogGeneration);

  const submit = async () => {
    if (!canSubmit || pending) return;
    // The dialog may be closed, reopened, or pointed at another repo while the
    // create is in flight; only the instance that started it may close on the
    // answer (the generation guard mirrors the previous dialog's contract).
    const ownsResult = () => {
      const ui = useUi.getState();
      return (
        !!repoPath &&
        useRepo.getState().summary?.path === repoPath &&
        ui.createPrOpen &&
        ui.createPrGeneration === dialogGeneration
      );
    };
    const ok = await run(
      () =>
        createPr({
          base: targetBranch,
          head,
          title: title.trim(),
          body,
          draft,
          reviewers,
        }),
      ownsResult,
    );
    if (ok) closeCurrent();
  };

  return {
    head,
    branchNames,
    base,
    setBase,
    targetBranch,
    setStacked: setStackMode,
    canStack,
    stacked,
    parent: parent?.pr ?? null,
    mapRows,
    // Layers counted from the trunk; the new pull request is always the top
    // one, so it is "layer N of N" until something is stacked on it later.
    mapMeta: stacked ? `layer ${chain.length + 1} of ${chain.length + 1}` : "1 pull request",
    mergeNote: stacked ? mergeOrderNote(chain) : "",
    range,
    title,
    setTitle,
    body,
    setBody,
    tab,
    setTab,
    draft,
    setDraft,
    reviewers,
    setReviewers,
    candidates,
    templates,
    replacedBody,
    account: prAccount,
    applyTemplate: async (template: PrTemplateRef) => {
      if (!repoPath) return;
      const text = await readTemplate(repoPath, template.path);
      if (text !== null) applyBody(text);
    },
    fillFromCommits: () => applyBody(bodyFromCommits(range.commits)),
    restoreDraft: () => {
      if (replacedBody === null) return;
      setBody(replacedBody);
      setReplacedBody(null);
    },
    canSubmit,
    pending,
    creating,
    closeCurrent,
    submit,
  };
}

/** Local branches first, then remote-tracking ones, minus the head itself. */
function baseCandidates(branches: BranchInfo[], head: string): string[] {
  const locals = branches
    .filter((b) => b.kind === BranchKind.Local && b.name !== head)
    .map((b) => b.name);
  const remotes = branches
    .filter((b) => b.kind === BranchKind.Remote)
    .map((b) => ({ name: b.name, short: shortName(b) }))
    // A remote branch already offered under its local name adds nothing.
    .filter((remote) => !locals.includes(remote.short))
    .map((remote) => remote.name);
  return [...locals, ...remotes];
}

function guessBase(candidates: string[], head: string): string {
  for (const name of DEFAULT_BASE_GUESSES) {
    if (name !== head && candidates.includes(name)) return name;
  }
  return candidates[0] ?? DEFAULT_BASE_GUESSES[0];
}

/**
 * The remote to spell candidate refs against.
 *
 * The checked-out branch's own remote when it has one, else whichever remote
 * the repo's remote-tracking branches came from. The fallback matters: a branch
 * cut for stacking is typically not pushed yet, so it has no remote of its own,
 * but the layer below it certainly does.
 */
function branchRemote(branches: BranchInfo[], head: string | null): string | null {
  const branch = head
    ? branches.find((b) => b.kind === BranchKind.Local && b.name === head)
    : undefined;
  return (
    branch?.pushRemote ??
    branch?.upstreamRemote ??
    branch?.remote ??
    branches.find((b) => b.kind === BranchKind.Remote && b.remote)?.remote ??
    null
  );
}

/**
 * The branch a ref names, with any remote prefix removed.
 *
 * The prefix comes from the branch record's own `remote` field, never from
 * splitting on the first slash: a remote may itself contain a slash, and a
 * local `feature/x` has no prefix to strip at all.
 */
function branchNameOf(branches: BranchInfo[], ref: string): string {
  const branch = branches.find((b) => b.name === ref);
  return branch ? shortName(branch) : ref;
}

function shortName(branch: BranchInfo): string {
  const prefix = branch.kind === BranchKind.Remote && branch.remote ? `${branch.remote}/` : "";
  return prefix && branch.name.startsWith(prefix) ? branch.name.slice(prefix.length) : branch.name;
}
