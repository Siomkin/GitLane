import { api } from "@/lib/api";
import { fullCommitMessage, splitCommitMessage } from "@/lib/commitMessage";
import {
  BranchIcon,
  CheckIcon,
  CompareIcon,
  CopyIcon,
  FileTextIcon,
  HashIcon,
  PlusIcon,
  WarningIcon,
} from "@/components/ui/icons";
import { useRepo } from "@/store/repo";
import { buildCommitBatchPlan, buildSquashMessage, getSquashEligibility, isCommitReachableFromRemote } from "@/store/selection";
import { useUi } from "@/store/ui";
import { MenuPanel, useBranchOp, type MenuItem } from "@/components/chrome/overlays/shared";
import { previewConfirm } from "./previewConfirm";
import { promptAnnotatedTag, promptCreateWorktree, promptNewBranchWorktree } from "./prompts";

export function CommitContextMenu() {
  const menu = useUi((s) => s.commitMenu);
  const close = useUi((s) => s.closeOverlays);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const requestPrompt = useUi((s) => s.requestPrompt);
  const openCreateBranchFrom = useUi((s) => s.openCreateBranchFrom);
  const openStackedReview = useUi((s) => s.openStackedReview);
  const openRangeReview = useUi((s) => s.openRangeReview);
  const openCompare = useRepo((s) => s.openCompare);
  const selectedCommit = useRepo((s) => s.selectedCommit);
  const summary = useRepo((s) => s.summary);
  const graph = useRepo((s) => s.graph);
  const checkoutBranch = useRepo((s) => s.checkoutBranch);
  const checkoutDetached = useRepo((s) => s.checkoutDetached);
  const cherryPickCommit = useRepo((s) => s.cherryPickCommit);
  const cherryPickMany = useRepo((s) => s.cherryPickMany);
  const revertCommit = useRepo((s) => s.revertCommit);
  const revertMany = useRepo((s) => s.revertMany);
  const squashSelection = useRepo((s) => s.squashSelection);
  const amendHeadMessage = useRepo((s) => s.amendHeadMessage);
  const createTagAt = useRepo((s) => s.createTagAt);
  const createAnnotatedTagAt = useRepo((s) => s.createAnnotatedTagAt);
  const createWorktreeAt = useRepo((s) => s.createWorktreeAt);
  const createPatchAt = useRepo((s) => s.createPatchAt);
  const resetCurrentTo = useRepo((s) => s.resetCurrentTo);
  const mergeInto = useRepo((s) => s.mergeInto);
  const rebaseOnto = useRepo((s) => s.rebaseOnto);
  const run = useBranchOp();
  if (!menu) return null;

  const { sha, shortSha } = menu;
  const cur = summary?.headBranch ?? "HEAD";
  const repoPath = summary?.path ?? null;
  const workdir = summary?.workdir ?? summary?.path ?? "";
  const resetHeadPrecondition = {
    branch: summary?.headBranch ?? null,
    oid: summary?.headOid ?? null,
  };

  const act = (op: () => Promise<string>) => {
    close();
    void run(op);
  };

  // ---- Batch menu: a range/additive selection of 2+ commits ----
  // Ordered by graph row so operation order and the inclusive compare range
  // are derived once by the pure selection helper.
  const selection = menu.selection ?? [];
  const batch = buildCommitBatchPlan(graph, selection);
  const orderedSel = batch.ordered;
  if (selection.length > 1) {
    const n = selection.length;
    const oldest = orderedSel[orderedSel.length - 1];
    const newest = orderedSel[0];
    const squash = getSquashEligibility(graph, orderedSel);
    const items: MenuItem[] = [
      { label: `${n} commits selected`, header: true },
      {
        label: `Cherry-pick ${n} commits onto ${cur}`,
        sep: true,
        onClick: () => {
          // git cherry-pick applies oldest-first; reverse the graph (newest-first)
          // order so the commits replay in chronological order.
          act(() => cherryPickMany(batch.cherryPickOrder));
        },
      },
      { label: `Revert ${n} commits`, onClick: () => act(() => revertMany(batch.revertOrder)) },
      ...(squash.ok
        ? [{
            label: `Squash ${n} commits…`,
            onClick: () =>
              requestPrompt({
                title: `Squash ${n} commits into one`,
                message: "Only local, unpublished commits at the current branch tip can be squashed.",
                placeholder: "Subject\n\nDescription",
                // Seed with the combined original messages so the squash keeps their
                // content and stays valid for repos whose commit-msg hook enforces a
                // format (e.g. Conventional Commits); a generic placeholder is rejected.
                defaultValue: buildSquashMessage(graph, orderedSel),
                multiline: true,
                confirmLabel: "Squash",
                onSubmit: (msg) => void run(() => squashSelection(orderedSel, msg)),
              }),
          }]
        : []),
      ...(batch.compareRange
        ? [{
            label: `Compare ${oldest.slice(0, 7)}…${newest.slice(0, 7)}`,
            sep: true,
            onClick: () => {
              close();
              openRangeReview(
                batch.compareRange!.base,
                batch.compareRange!.head,
                `Comparing ${n} commits`,
              );
            },
          }]
        : []),
      {
        label: `Copy ${n} commit SHAs`,
        onClick: () => {
          close();
          void navigator.clipboard?.writeText(orderedSel.join("\n"));
        },
      },
    ];
    return <MenuPanel left={menu.x} top={menu.y} items={items} onClose={close} width={260} />;
  }

  // ---- Single-commit menu ----
  // The commit's summary/body come from the loaded graph (no standalone
  // commit-detail command exists). Falls back to the short sha when truncated.
  const commit = graph?.commits.find((c) => c.id === sha && !c.stash);
  const subject = commit?.summary ?? shortSha;
  const body = commit?.body ?? "";
  const canRewordHead =
    !!summary?.headBranch &&
    !!commit &&
    graph?.head === sha &&
    !isCommitReachableFromRemote(graph, sha);

  const hasOtherSelected = !!selectedCommit && selectedCommit !== sha;

  const top: MenuItem[] = [
    { label: "Review all changes", icon: <FileTextIcon className="h-4 w-4" />, onClick: () => { close(); openStackedReview(sha, `Reviewing ${shortSha}`); } },
    { label: "Checkout commit", icon: <CheckIcon className="h-4 w-4" />, onClick: () => act(() => checkoutDetached(sha)) },
  ];

  const groups: MenuItem[] = [
    {
      label: "Compare",
      icon: <CompareIcon className="h-4 w-4" />,
      submenu: [
        { label: "With working tree", onClick: () => { close(); void openCompare({ base: sha, head: null, baseLabel: shortSha, headLabel: "Working tree", scope: "working", title: `Comparing ${shortSha} with the working tree` }); } },
        {
          label: hasOtherSelected ? `With ${selectedCommit!.slice(0, 7)}` : "With selected commit…",
          onClick: () => {
            close();
            if (hasOtherSelected) {
              void openCompare({ base: selectedCommit!, head: sha, baseLabel: selectedCommit!.slice(0, 7), headLabel: shortSha, scope: "commit", title: `Comparing ${shortSha} with ${selectedCommit!.slice(0, 7)}` });
            } else {
              requestPrompt({ title: `Compare ${shortSha} with…`, message: "Another commit-ish to compare against (it becomes the base).", placeholder: "HEAD~1, a branch, or a SHA", confirmLabel: "Compare", onSubmit: (other) => { const base = other.trim(); if (!base) return; void openCompare({ base, head: sha, baseLabel: base.length > 12 ? base.slice(0, 7) : base, headLabel: shortSha, scope: "commit", title: `Comparing ${shortSha} with ${base}` }); } });
            }
          },
        },
      ],
    },
    {
      label: "Integrate into current",
      icon: <BranchIcon className="h-4 w-4" />,
      note: `into ${cur}`,
      submenu: [
        { label: `Merge ${shortSha}`, onClick: () => act(() => mergeInto(sha, cur)) },
        { label: `Rebase onto ${shortSha}`, onClick: () => act(async () => { if (cur !== "HEAD") await checkoutBranch(cur); return rebaseOnto(sha); }) },
        { label: "Cherry-pick", onClick: () => act(() => cherryPickCommit(sha)) },
        { label: "Revert", onClick: () => act(() => revertCommit(sha)) },
      ],
    },
    {
      label: "Create",
      icon: <PlusIcon className="h-4 w-4" />,
      submenu: [
        { label: "Branch from here…", onClick: () => openCreateBranchFrom(sha) },
        { label: "Worktree from commit…", onClick: () => promptCreateWorktree(requestPrompt, run, createWorktreeAt, sha, workdir, shortSha) },
        { label: "New branch in worktree…", onClick: () => promptNewBranchWorktree(requestPrompt, run, createWorktreeAt, sha, workdir, shortSha) },
        { label: "Tag here…", onClick: () => requestPrompt({ title: `Create tag at ${shortSha}`, placeholder: "v1.0.0", confirmLabel: "Create tag", onSubmit: (name) => void run(() => createTagAt(name, sha)) }) },
        { label: "Annotated tag here…", onClick: () => promptAnnotatedTag(requestPrompt, run, createAnnotatedTagAt, sha, shortSha) },
        { label: "Patch from commit", onClick: () => act(() => createPatchAt(sha)) },
      ],
    },
  ];

  const copy: MenuItem[] = [
    { label: "Copy commit SHA", icon: <HashIcon className="h-4 w-4" />, onClick: () => { close(); void navigator.clipboard?.writeText(sha); } },
    {
      label: "Copy",
      icon: <CopyIcon className="h-4 w-4" />,
      submenu: [
        { label: "Subject", onClick: () => { close(); void navigator.clipboard?.writeText(subject); } },
        { label: "Full message", onClick: () => { close(); const full = body ? `${subject}\n\n${body}` : subject; void navigator.clipboard?.writeText(full); } },
      ],
    },
  ];

  const danger: MenuItem[] = [];
  if (canRewordHead) {
    danger.push({ label: "Edit commit message…", onClick: () => requestPrompt({ title: "Edit commit message", message: `This commit has not been pushed: ${shortSha}.`, placeholder: "Subject\n\nDescription", defaultValue: fullCommitMessage(subject, body), multiline: true, confirmLabel: "Update message", onSubmit: (msg) => { const next = splitCommitMessage(msg); void run(() => amendHeadMessage(next.summary, next.description)); } }) });
  }
  danger.push({ label: `Reset ${cur} to here`, header: true, danger: true, sep: danger.length > 0 });
  danger.push({ label: "Soft — keep changes staged", indent: true, onClick: () => void previewConfirm({ requestConfirm, title: `Reset ${cur} to ${shortSha}?`, message: "Soft reset — changes are kept staged.", confirmLabel: "Reset (soft)", preview: () => repoPath ? api.previewReset(repoPath, sha, "soft") : Promise.reject(new Error("No repository")), onConfirm: () => void run(() => resetCurrentTo(sha, "soft")), headPrecondition: resetHeadPrecondition }) });
  danger.push({ label: "Mixed — keep changes unstaged", indent: true, onClick: () => void previewConfirm({ requestConfirm, title: `Reset ${cur} to ${shortSha}?`, message: "Mixed reset — changes are kept in the working tree, unstaged.", confirmLabel: "Reset (mixed)", preview: () => repoPath ? api.previewReset(repoPath, sha, "mixed") : Promise.reject(new Error("No repository")), onConfirm: () => void run(() => resetCurrentTo(sha, "mixed")), headPrecondition: resetHeadPrecondition }) });
  danger.push({ label: "Hard — discard changes", indent: true, danger: true, onClick: () => void previewConfirm({ requestConfirm, title: `Reset ${cur} to ${shortSha}?`, message: "Hard reset — all uncommitted working-tree changes will be permanently discarded.", confirmLabel: "Reset (hard)", danger: true, preview: () => repoPath ? api.previewReset(repoPath, sha, "hard") : Promise.reject(new Error("No repository")), onConfirm: () => void run(() => resetCurrentTo(sha, "hard")), headPrecondition: resetHeadPrecondition }) });

  const items: MenuItem[] = [...top];
  groups[0] = { ...groups[0], sep: true };
  items.push(...groups);
  copy[0] = { ...copy[0], sep: true };
  items.push(...copy);
  items.push({ label: "Danger zone", icon: <WarningIcon className="h-4 w-4" />, tone: "danger", sep: true, submenu: danger });

  return <MenuPanel left={menu.x} top={menu.y} items={items} onClose={close} width={236} />;
}
