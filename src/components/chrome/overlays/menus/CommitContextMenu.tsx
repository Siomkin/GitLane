import { api } from "@/lib/api";
import { fullCommitMessage, splitCommitMessage } from "@/lib/commitMessage";
import { openExternalUrl } from "@/lib/openExternal";
import {
  BranchIcon,
  CheckIcon,
  CompareIcon,
  CopyIcon,
  ExternalLinkIcon,
  HashIcon,
  PlusIcon,
  WarningIcon,
} from "@/components/ui/icons";
import { useRepo } from "@/store/repo";
import { buildCommitBatchPlan, buildSquashMessage, getSquashEligibility } from "@/store/selection";
import { useUi } from "@/store/ui";
import { MenuPanel, useBranchOp, type MenuItem } from "@/components/chrome/overlays/shared";
import { deriveCommitContextMenuPolicy } from "./commitContextMenuPolicy";
import { previewConfirm } from "./previewConfirm";
import { promptAnnotatedTag, promptCreateWorktree, promptNewBranchWorktree } from "./prompts";
import { confirmRebase } from "./rebaseConfirm";

export function CommitContextMenu() {
  const menu = useUi((s) => s.commitMenu);
  const close = useUi((s) => s.closeOverlays);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const requestPrompt = useUi((s) => s.requestPrompt);
  const openCreateBranchFrom = useUi((s) => s.openCreateBranchFrom);
  const openRangeReview = useUi((s) => s.openRangeReview);
  const openCompare = useRepo((s) => s.openCompare);
  const selectedCommit = useRepo((s) => s.selectedCommit);
  const summary = useRepo((s) => s.summary);
  const graph = useRepo((s) => s.graph);
  const forge = useRepo((s) => s.forge);
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
  const createPatchRangeAt = useRepo((s) => s.createPatchRangeAt);
  const resetBranchTo = useRepo((s) => s.resetBranchTo);
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
    // Same relative order as the single-commit menu (integrate → compare → copy),
    // each group separated so a user who learned one menu reads the other at a
    // glance. Batch keeps Copy N SHAs — multi-select has no right-panel copy.
    const items: MenuItem[] = [
      {
        label: `Cherry-pick ${n} commits onto ${cur}`,
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
      // Patch from a contiguous selection only — the same first-parent range the
      // compare row uses; a non-contiguous selection has no single base..head.
      ...(batch.compareRange
        ? [{
            label: `Create patch from ${n} commits`,
            sep: true,
            onClick: () => act(() => createPatchRangeAt(batch.compareRange!.base, batch.compareRange!.head)),
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
        sep: true,
        onClick: () => {
          close();
          void navigator.clipboard?.writeText(orderedSel.join("\n"));
        },
      },
    ];
    return (
      <MenuPanel
        left={menu.x}
        top={menu.y}
        items={items}
        onClose={close}
        width={260}
        heading={batchHeading(n)}
      />
    );
  }

  // ---- Single-commit menu ----
  // Eligibility (subject/body lookup, local-only reword gate, forge-link
  // visibility, compare-with-selected) is derived once by the pure policy.
  const policy = deriveCommitContextMenuPolicy({
    sha,
    shortSha,
    graph,
    forge,
    headBranch: summary?.headBranch ?? null,
    selectedCommit,
  });
  const { subject, body, canRewordHead, forgeCommitUrl, forgeName, otherSelected } = policy;

  // Right-clicking the commit text gives the same git actions as its branch pill
  // (the pill just adds ref-level ops on top).
  const top: MenuItem[] = [
    { label: "Checkout commit", icon: <CheckIcon className="h-4 w-4" />, onClick: () => act(() => checkoutDetached(sha)) },
  ];

  // Integrate: cherry-pick/revert stay flat (the everyday commit verbs); merge
  // and rebase onto a raw commit are the rare power move, folded away. The
  // "onto current" ops (cherry-pick/merge/rebase) are hidden when the target is
  // HEAD — they're no-ops there, and cherry-picking HEAD would leave git in an
  // empty cherry-pick sequence. Revert stays (reverting HEAD is meaningful). The
  // branch menu applies the same gate, so the HEAD-commit and current-branch
  // menus stay identical.
  const isHeadCommit = graph?.head === sha;
  const integrate: MenuItem[] = [];
  if (!isHeadCommit) {
    integrate.push({ label: `Cherry-pick onto ${cur}`, onClick: () => act(() => cherryPickCommit(sha)) });
  }
  integrate.push({ label: "Revert commit", onClick: () => act(() => revertCommit(sha)) });
  if (!isHeadCommit) {
    integrate.push({
      label: "Integrate into current",
      note: `into ${cur}`,
      submenu: [
        { label: `Merge ${shortSha}`, onClick: () => act(() => mergeInto(sha, cur)) },
        {
          label: `Rebase onto ${shortSha}`,
          onClick: () =>
            confirmRebase({
              source: cur,
              onto: shortSha,
              needsCheckout: false,
              requestConfirm,
              proceed: () => act(() => rebaseOnto(cur, sha)),
            }),
        },
      ],
    });
  }
  integrate[0] = { ...integrate[0], sep: true, icon: <BranchIcon className="h-4 w-4" /> };

  // Create: branch stays flat (the common one); the rarer create targets fold
  // into one submenu.
  const create: MenuItem[] = [
    { label: "Create branch here…", icon: <PlusIcon className="h-4 w-4" />, sep: true, onClick: () => openCreateBranchFrom(sha) },
    {
      label: "Create",
      submenu: [
        { label: "Tag here…", onClick: () => requestPrompt({ title: `Create tag at ${shortSha}`, placeholder: "v1.0.0", confirmLabel: "Create tag", onSubmit: (name) => void run(() => createTagAt(name, sha)) }) },
        { label: "Annotated tag here…", onClick: () => promptAnnotatedTag(requestPrompt, run, createAnnotatedTagAt, sha, shortSha) },
        { label: "Worktree at commit…", onClick: () => promptCreateWorktree(requestPrompt, run, createWorktreeAt, sha, workdir, shortSha, { detached: true }) },
        { label: "Worktree with branch…", onClick: () => promptNewBranchWorktree(requestPrompt, run, createWorktreeAt, sha, workdir, shortSha) },
        { label: "Patch from commit", onClick: () => act(() => createPatchAt(sha)) },
      ],
    },
    {
      label: "Compare",
      icon: <CompareIcon className="h-4 w-4" />,
      submenu: [
        { label: "With working tree", onClick: () => { close(); void openCompare({ base: sha, head: null, baseLabel: shortSha, headLabel: "Working tree", scope: "working", title: `Comparing ${shortSha} with the working tree` }); } },
        {
          label: otherSelected ? `With ${otherSelected.slice(0, 7)}` : "With selected commit…",
          onClick: () => {
            close();
            if (otherSelected) {
              void openCompare({ base: otherSelected, head: sha, baseLabel: otherSelected.slice(0, 7), headLabel: shortSha, scope: "commit", title: `Comparing ${shortSha} with ${otherSelected.slice(0, 7)}` });
            } else {
              requestPrompt({ title: `Compare ${shortSha} with…`, message: "Another commit-ish to compare against (it becomes the base).", placeholder: "HEAD~1, a branch, or a SHA", confirmLabel: "Compare", onSubmit: (other) => { const base = other.trim(); if (!base) return; void openCompare({ base, head: sha, baseLabel: base.length > 12 ? base.slice(0, 7) : base, headLabel: shortSha, scope: "commit", title: `Comparing ${shortSha} with ${base}` }); } });
            }
          },
        },
      ],
    },
  ];

  // Copy: SHA flat (the everyday one), subject/full-message/link folded into a
  // submenu. "Link to commit" only when the commit has a forge URL.
  const copy: MenuItem[] = [
    { label: "Copy commit SHA", icon: <HashIcon className="h-4 w-4" />, sep: true, onClick: () => { close(); void navigator.clipboard?.writeText(sha); } },
    {
      label: "Copy",
      icon: <CopyIcon className="h-4 w-4" />,
      submenu: [
        { label: "Subject", onClick: () => { close(); void navigator.clipboard?.writeText(subject); } },
        { label: "Full message", onClick: () => { close(); void navigator.clipboard?.writeText(body ? `${subject}\n\n${body}` : subject); } },
        ...(forgeCommitUrl
          ? [{ label: "Link to commit", onClick: () => { close(); void navigator.clipboard?.writeText(forgeCommitUrl); } }]
          : []),
      ],
    },
  ];

  // Open on the forge.
  const openRemote: MenuItem[] = [];
  if (forgeCommitUrl) {
    openRemote.push({
      label: forgeName ? `View on ${forgeName}` : "View on remote",
      icon: <ExternalLinkIcon className="h-4 w-4" />,
      sep: true,
      onClick: () => { close(); openExternalUrl(forgeCommitUrl); },
    });
  }

  // Danger: reword (unpushed HEAD only, until the history-rewrite ticket) as a
  // flat row, then a first-level, danger-toned "Reset ‹cur› to here ▸" — kept at
  // the first level so Reset sits at the same depth as it does on the branch menu.
  const danger: MenuItem[] = [];
  if (canRewordHead) {
    danger.push({ label: "Edit commit message…", sep: true, onClick: () => requestPrompt({ title: "Edit commit message", message: `This commit has not been pushed: ${shortSha}.`, placeholder: "Subject\n\nDescription", defaultValue: fullCommitMessage(subject, body), multiline: true, confirmLabel: "Update message", onSubmit: (msg) => { const next = splitCommitMessage(msg); void run(() => amendHeadMessage(next.summary, next.description)); } }) });
  }
  const resetMode = (mode: "soft" | "mixed" | "hard", label: string, message: string): MenuItem => ({
    label,
    danger: mode === "hard",
    onClick: () => void previewConfirm({ requestConfirm, title: `Reset ${cur} to ${shortSha}?`, message, confirmLabel: `Reset (${mode})`, danger: mode === "hard", preview: () => repoPath ? api.previewReset(repoPath, sha, mode) : Promise.reject(new Error("No repository")), onConfirm: (preview) => void run(() => resetBranchTo(summary?.headBranch ?? null, sha, mode, preview)), headPrecondition: resetHeadPrecondition }),
  });
  danger.push({
    label: `Reset ${cur} to here`,
    icon: <WarningIcon className="h-4 w-4" />,
    tone: "danger",
    // Always start the danger group with a divider: Edit (when present) is first
    // and carries it; otherwise Reset does.
    sep: !canRewordHead,
    submenu: [
      resetMode("soft", "Soft — keep changes staged", "Soft reset — changes are kept staged."),
      resetMode("mixed", "Mixed — keep changes unstaged", "Mixed reset — changes are kept in the working tree, unstaged."),
      resetMode("hard", "Hard — discard changes", "Hard reset — all uncommitted working-tree changes will be permanently discarded."),
    ],
  });

  const items: MenuItem[] = [...top, ...integrate, ...create, ...copy, ...openRemote, ...danger];
  return (
    <MenuPanel left={menu.x} top={menu.y} items={items} onClose={close} width={248} heading={commitHeading(shortSha, subject)} />
  );
}

/** The single-commit heading: short sha (mono, accent) + truncated subject, so
 * the menu always names the commit it acts on — visually distinct from the
 * branch pill menu that opens on the same row. */
function commitHeading(shortSha: string, subject: string) {
  return (
    <div className="flex w-full items-center gap-1.5">
      <span className="shrink-0 font-mono text-[12px] font-medium text-[color:var(--accent)]">{shortSha}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-600 dark:text-neutral-300">{subject}</span>
    </div>
  );
}

/** The batch heading, matching the single-commit menu's heading treatment. */
function batchHeading(n: number) {
  return (
    <div className="flex w-full items-center gap-1.5">
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-neutral-700 dark:text-neutral-200">
        {n} commits selected
      </span>
    </div>
  );
}
