import { BranchIcon } from "@/components/ui/icons";
import { type MenuItem } from "@/components/chrome/overlays/shared";
import { confirmRebase } from "@/components/chrome/overlays/menus/rebaseConfirm";
import { confirmRevert } from "@/components/chrome/overlays/menus/revertConfirm";
import type { BranchMenuContext } from "./context";

// ---- integrate: identical structure to the commit menu — Cherry-pick and
// Revert are flat rows acting on the tip commit; the branch-level integrate
// verbs (fast-forward / merge / rebase onto ‹b›) fold into one submenu. Shown
// whenever there's a current branch and a tip, so the branch pill matches the
// commit menu on the same row (including on the current branch). Assembled
// just above Reset / Danger zone at the bottom, so Revert — the closest thing
// to a "reset the other way" — sits next to Reset.
// The "onto current" ops are hidden when the tip is HEAD (the branch is
// current, or points at HEAD) — they'd be no-ops there, and cherry-picking HEAD
// leaves git in an empty cherry-pick sequence. Revert stays. Same gate as the
// commit menu at HEAD, so the two menus stay identical on the current branch.
export function integrateItems(ctx: BranchMenuContext): MenuItem[] {
  const {
    b,
    cur,
    tip,
    isCurrent,
    headOid,
    act,
    canFf,
    requestConfirm,
    cherryPickCommit,
    fastForwardTo,
    mergeInto,
    rebaseOnto,
    revertCommit,
  } = ctx;

  const integrate: MenuItem[] = [];
  if (tip && cur) {
    // "Self" means the tip is already current — hide the onto-current ops (they'd
    // be no-ops and cherry-pick would leave an empty sequence). Guard on the menu
    // snapshot (isCurrent), the live name match (b === cur), AND the oid match —
    // so an unborn/odd summary with a null headOid can't slip the ops through.
    const selfTarget = isCurrent || b === cur || (headOid != null && tip === headOid);
    if (!selfTarget) {
      integrate.push({ label: `Cherry-pick onto ${cur}`, onClick: () => act(() => cherryPickCommit(tip)) });
      const integrateChildren: MenuItem[] = [];
      if (canFf) integrateChildren.push({ label: `Fast-forward to ${b}`, onClick: () => act(() => fastForwardTo(b, cur)) });
      integrateChildren.push({ label: `Merge ${b}`, onClick: () => act(() => mergeInto(b, cur)) });
      integrateChildren.push({
        label: `Rebase onto ${b}`,
        onClick: () =>
          confirmRebase({
            source: cur,
            onto: b,
            needsCheckout: false,
            requestConfirm,
            proceed: () => act(() => rebaseOnto(cur, b)),
          }),
      });
      integrate.push({ label: "Integrate into current", note: `into ${cur}`, submenu: integrateChildren });
    }
    // Revert last, so it lands right next to Reset in the assembled menu.
    integrate.push({
      label: "Revert commit",
      onClick: () =>
        confirmRevert({
          // `tipShort` is the policy's `tip.slice(0, 7)` but typed
          // `string | null` independently of the enclosing `if (tip && cur)`,
          // so derive the short oid from the narrowed `tip` instead.
          shortSha: tip.slice(0, 7),
          branch: cur,
          requestConfirm,
          proceed: () => act(() => revertCommit(tip)),
        }),
    });
    // The section's first row carries the group glyph, matching the commit menu.
    integrate[0] = { ...integrate[0], icon: <BranchIcon className="h-4 w-4" /> };
  }
  return integrate;
}
