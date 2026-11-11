import { cn } from "@/lib/cn";
import { MONO_FONT } from "@/lib/ui";
import { BranchIcon, CloudIcon } from "@/components/ui/icons";
import { middleEllipsis } from "./impactLines";

export type RefChipKind = "branch" | "remote" | "commit";

/** A ref name as a chip — shared by the confirm dialog's ref facts and the drop
 * menu header. Long names are cut in the middle (`max` chars), with the full
 * name as tooltip. */
export function RefChip({
  name,
  kind = "branch",
  max,
  className,
}: {
  name: string;
  kind?: RefChipKind;
  max?: number;
  className?: string;
}) {
  const Icon = kind === "remote" ? CloudIcon : kind === "branch" ? BranchIcon : null;
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
      <span className="truncate">{middleEllipsis(name, max)}</span>
    </span>
  );
}
