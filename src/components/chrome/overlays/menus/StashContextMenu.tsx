import { CheckIcon, CopyIcon, FileTextIcon, TrashIcon } from "@/components/ui/icons";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { MenuPanel, useBranchOp, type MenuItem } from "@/components/chrome/overlays/shared";

export function StashContextMenu() {
  const menu = useUi((s) => s.stashMenu);
  const close = useUi((s) => s.closeOverlays);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const requestPrompt = useUi((s) => s.requestPrompt);
  const showToast = useUi((s) => s.showToast);
  const openStackedReview = useUi((s) => s.openStackedReview);
  const applyStash = useRepo((s) => s.applyStash);
  const branchFromStash = useRepo((s) => s.branchFromStash);
  const dropStash = useRepo((s) => s.dropStash);
  const run = useBranchOp();
  if (!menu) return null;

  // Everything acts on the stash's commit oid — a `stash@{n}` index captured
  // when the menu opened can drift if another worktree/terminal touches the
  // stash stack before the click lands (GL-117).
  const { oid, message } = menu;

  const items: MenuItem[] = [
    { label: "View changes", icon: <FileTextIcon className="h-4 w-4" />, onClick: () => { close(); openStackedReview(oid, `Stash: ${message}`); } },
    {
      label: "Apply",
      icon: <CheckIcon className="h-4 w-4" />,
      sep: true,
      submenu: [
        { label: "Apply", onClick: () => { close(); void run(() => applyStash(oid, false)); } },
        { label: "Apply with index", onClick: () => { close(); void run(() => applyStash(oid, false, true)); } },
        { label: "Pop (apply & drop)", onClick: () => { close(); void run(() => applyStash(oid, true)); } },
        {
          label: "Apply to new branch…",
          onClick: () =>
            requestPrompt({
              title: "Apply stash to a new branch",
              message: "Branches from the stash's parent commit, then applies the stash.",
              placeholder: "new-branch-name",
              confirmLabel: "Create & apply",
              onSubmit: (branch) => void run(() => branchFromStash(oid, branch)),
            }),
        },
      ],
    },
    {
      label: "Copy",
      icon: <CopyIcon className="h-4 w-4" />,
      sep: true,
      submenu: [
        { label: "Stash SHA", onClick: () => { close(); void navigator.clipboard?.writeText(oid); showToast(`Copied ${oid.slice(0, 7)}`); } },
        { label: "Stash message", onClick: () => { close(); void navigator.clipboard?.writeText(message); showToast("Copied stash message"); } },
      ],
    },
    {
      label: "Drop",
      icon: <TrashIcon className="h-4 w-4" />,
      danger: true,
      sep: true,
      onClick: () =>
        requestConfirm({
          title: "Drop this stash?",
          message: `"${message}" will be permanently deleted. This can't be undone.`,
          confirmLabel: "Drop stash",
          danger: true,
          onConfirm: () => void run(() => dropStash(oid)),
        }),
    },
  ];

  return <MenuPanel left={menu.x} top={menu.y} items={items} onClose={close} width={240} />;
}
