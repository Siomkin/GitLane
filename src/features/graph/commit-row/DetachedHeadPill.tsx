import { PillGlyph } from "./PillGlyph";

/** Marker for the checked-out commit while HEAD is detached. A branch checkout
 * is labelled by its branch pill's accent ✓, but a detached HEAD has no ref —
 * and the open worktree's own pill is deliberately excluded from the graph — so
 * without this the commit you are sitting on carries no label at all (the
 * avatar's HEAD ring is the only hint). Accent-toned like the current-branch
 * pill; not draggable and no context menu — it isn't a ref, just "you are
 * here". Says "detached" explicitly (the toolbar's vocabulary): a bare "HEAD"
 * would read as an ordinary checkout, hiding exactly the state that needs
 * flagging. */
export function DetachedHeadPill() {
  return (
    <span
      className="flex h-[22px] shrink-0 select-none items-center gap-1 whitespace-nowrap rounded-md bg-[var(--accent)] pl-1 pr-2 text-[11px] font-medium text-white shadow-sm"
      title="Detached HEAD — no branch checked out"
    >
      <PillGlyph icon="current" />
      <span>detached HEAD</span>
    </span>
  );
}
