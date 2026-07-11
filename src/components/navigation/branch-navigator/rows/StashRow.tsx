import { cn } from "@/lib/cn";
import type { StashEntry } from "@/lib/api";
import { useUi } from "@/store/ui";
import { useTruncatedTooltip } from "@/components/chrome/overlays";
import { HighlightMatch } from "@/components/ui/HighlightMatch";
import { StashIcon } from "@/components/ui/icons";
import { useRevealStashNavigate } from "../useRowActions";
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
  const openStashMenu = useUi((s) => s.openStashMenu);
  const tip = useTruncatedTooltip(stash.message);
  return (
    <div
      {...tip}
      className={cn(ROW_CLASS, dimmed && DIM_CLASS)}
      onClick={() => navigate(stash.oid)}
      onContextMenu={(e) => {
        e.preventDefault();
        openStashMenu({ x: e.clientX, y: e.clientY, oid: stash.oid, message: stash.message });
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
