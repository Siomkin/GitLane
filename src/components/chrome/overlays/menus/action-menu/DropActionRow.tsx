import type { ComponentType, SVGProps } from "react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import type { GraphActionKind } from "@/lib/graphActions";
import { FastForwardIcon, MergeIcon, RebaseIcon, ResetIcon } from "@/components/ui/icons";
import { middleEllipsis } from "@/components/chrome/overlays/dialogs/impactLines";

type Look = { verb: string; Icon: ComponentType<SVGProps<SVGSVGElement>>; tile: string };

const LOOKS: Record<string, Look> = {
  "fast-forward": { verb: "Fast-forward", Icon: FastForwardIcon, tile: "bg-[var(--nf-success-soft)] text-[color:var(--nf-success)]" },
  merge: { verb: "Merge", Icon: MergeIcon, tile: "bg-[var(--accent-soft)] text-[color:var(--accent)]" },
  rebase: { verb: "Rebase", Icon: RebaseIcon, tile: "bg-[var(--nf-info-soft)] text-[color:var(--nf-info)]" },
  reset: { verb: "Reset", Icon: ResetIcon, tile: "bg-[var(--nf-error-soft)] text-[color:var(--nf-error)]" },
};

/** `fast-forward-source` → the fast-forward look; the kind's last segment is the direction. */
const lookOf = (kind: GraphActionKind) => LOOKS[kind.slice(0, kind.lastIndexOf("-"))];

interface Props {
  kind: GraphActionKind;
  /** Full sentence naming both refs — the accessible name and tooltip. */
  label: string;
  sub: string;
  disabled: boolean;
  /** Visible short reason; `disabledReason` is the full one for assistive tech. */
  heldBy: string | null;
  disabledReason: string | null;
  onClick: () => void;
}

/** A drop-menu outcome: tone tile, the verb, and one line saying which side moves. */
export function DropActionRow({ kind, label, sub, disabled, heldBy, disabledReason, onClick }: Props) {
  const { verb, Icon, tile } = lookOf(kind);
  const reasonId = disabledReason ? `action-reason-${kind}` : undefined;
  const line = disabled && heldBy ? `Checked out in worktree ${heldBy}` : sub;
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      aria-label={label}
      aria-describedby={reasonId}
      title={disabledReason ?? label}
      onClick={disabled ? undefined : onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2 py-[7px] text-left",
        focusRing,
        disabled ? "cursor-not-allowed opacity-60" : "hover:bg-black/5 dark:hover:bg-white/5",
      )}
    >
      <span aria-hidden className={cn("grid h-7 w-7 flex-none place-items-center rounded-lg", tile)}>
        <Icon className="h-4 w-4" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-100">{verb}</span>
        {/* Only the counterpart rebase names a ref here; cut it in the middle like the chips. */}
        <span className="truncate text-[11.5px] text-neutral-500 dark:text-neutral-400">{middleEllipsis(line, 38)}</span>
      </span>
      {reasonId && (
        <span id={reasonId} className="sr-only">
          {disabledReason}
        </span>
      )}
    </button>
  );
}
