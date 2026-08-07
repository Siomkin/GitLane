import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import type { StashEntry } from "@/lib/api";
import { useUi, MenuKind } from "@/store/ui";
import { useTruncatedTooltip } from "@/components/chrome/overlays";
import { HighlightMatch } from "@/components/ui/HighlightMatch";
import { StashIcon } from "@/components/ui/icons";
import { useRevealStashNavigate } from "@/components/navigation/branch-navigator/useRowActions";
import { DIM_CLASS } from "./rowStyles";

const ROW_CLASS =
  "flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-[13px] text-neutral-600 transition-opacity hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5";

/** A stash row — click jumps to its graph row; right-click for apply/pop/drop. */
export function StashRow({
  stash,
  dimmed = false,
  query = "",
}: {
  stash: StashEntry;
  dimmed?: boolean;
  query?: string;
}) {
  const navigate = useRevealStashNavigate();
  const openMenu = useUi((s) => s.openMenu);
  const tip = useTruncatedTooltip(stash.message);
  return (
    <div
      {...tip}
      role="button"
      tabIndex={0}
      aria-label={`Reveal stash ${stash.message}`}
      className={cn(ROW_CLASS, focusRing, dimmed && DIM_CLASS)}
      onClick={() => navigate(stash.oid)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          navigate(stash.oid);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu({ kind: MenuKind.Stash, state: { x: e.clientX, y: e.clientY, oid: stash.oid, message: stash.message } });
      }}
    >
      <StashIcon className="h-3.5 w-3.5 shrink-0 text-amber-500" />
      <span data-truncate className="min-w-0 flex-1 truncate">
        <HighlightMatch text={stash.message} query={query} />
      </span>
      <span className="shrink-0 font-mono text-[10px] text-neutral-400">{`{${stash.index}}`}</span>
    </div>
  );
}
