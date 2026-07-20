import { CheckIcon, CopyIcon, PlusIcon, PushIcon, TrashIcon } from "@/components/ui/icons";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { MenuPanel, useBranchOp, type MenuItem } from "@/components/chrome/overlays/shared";
import { promptCreateWorktree } from "./prompts";

/** Right-click menu on a tag ref (graph pill or navigator row). Tags are
 * immutable pointers, so the menu reads the tagged commit and offers the same
 * "go to / branch from this point" actions as a commit, plus copy, push, and
 * delete. Delete comes in two strengths: local-only (fetch re-imports the tag
 * while it exists on the remote) and local + remote. Push and delete name the
 * actual remote (GL-129); with several remotes configured, push becomes a
 * per-remote submenu while delete-everywhere targets the default remote. */
export function TagContextMenu() {
  const menu = useUi((s) => s.tagMenu);
  const close = useUi((s) => s.closeOverlays);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const requestPrompt = useUi((s) => s.requestPrompt);
  const openCreateBranchFrom = useUi((s) => s.openCreateBranchFrom);
  const workdir = useRepo((s) => s.summary?.workdir ?? s.summary?.path ?? "");
  const checkoutDetached = useRepo((s) => s.checkoutDetached);
  const createWorktreeAt = useRepo((s) => s.createWorktreeAt);
  const remotes = useRepo((s) => s.remotes);
  const pushTag = useRepo((s) => s.pushTag);
  const deleteTag = useRepo((s) => s.deleteTag);
  const run = useBranchOp();
  if (!menu) return null;

  const { name, sha, refOid } = menu;
  const defaultRemote = remotes.find((r) => r.isDefault)?.name ?? remotes[0]?.name ?? "origin";

  // Operate on the peeled commit `sha`, never the tag name: a branch and tag can
  // share a short name, and `git branch new <name>` then fails as ambiguous.
  // `name` stays only for labels and the default worktree path.
  const items: MenuItem[] = [
    { label: "Checkout tag (detached)", icon: <CheckIcon className="h-4 w-4" />, onClick: () => { close(); void run(() => checkoutDetached(sha)); } },
    remotes.length > 1
      ? {
          label: "Push tag to",
          icon: <PushIcon className="h-4 w-4" />,
          submenu: remotes.map((r) => ({
            label: r.name,
            onClick: () => {
              close();
              void run(() => pushTag(name, r.name));
            },
          })),
        }
      : { label: `Push tag to ${defaultRemote}`, icon: <PushIcon className="h-4 w-4" />, onClick: () => { close(); void run(() => pushTag(name)); } },
    {
      label: "Create",
      icon: <PlusIcon className="h-4 w-4" />,
      sep: true,
      submenu: [
        { label: "Branch from here…", onClick: () => openCreateBranchFrom(sha) },
        { label: "Worktree from tag…", onClick: () => promptCreateWorktree(requestPrompt, run, createWorktreeAt, sha, workdir, name, { detached: true }) },
      ],
    },
    {
      label: "Copy tag name",
      icon: <CopyIcon className="h-4 w-4" />,
      sep: true,
      onClick: () => { close(); void navigator.clipboard?.writeText(name); },
    },
    {
      label: "Delete local tag",
      icon: <TrashIcon className="h-4 w-4" />,
      danger: true,
      sep: true,
      onClick: () =>
        requestConfirm({
          title: `Delete tag ${name}?`,
          message: `Only the local tag ref is removed. If the tag was pushed, the next fetch re-imports it from ${defaultRemote} — use “Delete from local and ${defaultRemote}” to remove it for good.`,
          confirmLabel: "Delete local tag",
          danger: true,
          onConfirm: () => void run(() => deleteTag(name, refOid)),
        }),
    },
    {
      label: `Delete from local and ${defaultRemote}`,
      icon: <TrashIcon className="h-4 w-4" />,
      danger: true,
      onClick: () =>
        requestConfirm({
          title: `Delete tag ${name} everywhere?`,
          message: `The tag is deleted on ${defaultRemote} and then locally. Other clones keep their copy until they prune, but fetch will no longer restore it here.`,
          confirmLabel: `Delete from local and ${defaultRemote}`,
          danger: true,
          onConfirm: () => void run(() => deleteTag(name, refOid, true)),
        }),
    },
  ];

  return <MenuPanel left={menu.x} top={menu.y} items={items} onClose={close} width={236} />;
}
