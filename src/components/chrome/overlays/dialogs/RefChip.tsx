import { cn } from "@/lib/cn";
import { MONO_FONT } from "@/lib/ui";
import { BranchIcon, CloudIcon } from "@/components/ui/icons";

export type RefChipKind = "branch" | "remote" | "commit";

/** Characters of a long name that always stay visible: the end is what tells
 * similar branches apart (`…-retry-backoff-v2`). */
const TAIL = 16;

/** A ref name as a chip — shared by the confirm dialog's ref facts and the drop
 * menu header. A name too wide for its space is cut in the middle by CSS: the
 * head shrinks with an ellipsis while the tail never does, so the cut lands
 * exactly where the space runs out and happens once. The full name is the
 * tooltip. */
export function RefChip({
  name,
  kind = "branch",
  className,
}: {
  name: string;
  kind?: RefChipKind;
  className?: string;
}) {
  const Icon = kind === "remote" ? CloudIcon : kind === "branch" ? BranchIcon : null;
  const split = name.length > TAIL * 2;
  return (
    <span
      title={name}
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium",
        kind === "branch"
          ? "bg-[var(--accent-soft)] text-[color:var(--accent)]"
          : "border border-[var(--chipBd)] bg-[var(--chip)] text-[color:var(--text2)]",
        className,
      )}
      style={kind === "commit" ? { fontFamily: MONO_FONT } : undefined}
    >
      {Icon && <Icon className="h-3 w-3 flex-none" />}
      {split ? (
        <span className="flex min-w-0 whitespace-pre">
          <span className="truncate">{name.slice(0, -TAIL)}</span>
          <span className="flex-none">{name.slice(-TAIL)}</span>
        </span>
      ) : (
        <span className="truncate">{name}</span>
      )}
    </span>
  );
}
