// A compact, colored breakdown of working-tree changes by type — added /
// modified / deleted (and conflicted when present) — used wherever a single
// change total would otherwise read as an opaque number. Zero buckets are
// omitted so a worktree with only edits shows just the pencil count.

import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import type { ChangeSummary } from "../../lib/changeSummary";
import { EditIcon } from "../../components/ui/icons";

interface Part {
  key: keyof ChangeSummary;
  count: number;
  tone: string;
  glyph: ReactNode;
  label: string;
}

export const ChangeTypeCounts = ({
  summary,
  className,
}: {
  summary: ChangeSummary;
  className?: string;
}) => {
  const parts: Part[] = [
    {
      key: "added",
      count: summary.added,
      tone: "text-[color:var(--accent)]",
      glyph: "+",
      label: "added",
    },
    {
      key: "modified",
      count: summary.modified,
      tone: "text-amber-600 dark:text-amber-300/80",
      glyph: <EditIcon width={12} height={12} />,
      label: "modified",
    },
    {
      key: "deleted",
      count: summary.deleted,
      tone: "text-rose-500",
      glyph: "−",
      label: "deleted",
    },
    {
      // Distinct from deleted's rose so a worktree with both stays scannable —
      // a saturated red reads as the alarm state, paired with the "!" glyph.
      key: "conflicted",
      count: summary.conflicted,
      tone: "text-red-600 dark:text-red-400",
      glyph: "!",
      label: "conflicted",
    },
  ];
  const shown = parts.filter((p) => p.count > 0);
  if (shown.length === 0) return null;

  return (
    <span className={cn("inline-flex items-center gap-2 text-[12px]", className)}>
      {shown.map((p) => (
        <span
          key={p.key}
          className={cn("inline-flex items-center gap-0.5 tabular-nums", p.tone)}
          title={`${p.count} ${p.label}`}
        >
          <span className="inline-flex w-3 justify-center font-semibold">{p.glyph}</span>
          {p.count}
        </span>
      ))}
    </span>
  );
};
