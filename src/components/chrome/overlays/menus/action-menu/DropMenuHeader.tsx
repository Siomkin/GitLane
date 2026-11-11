import { RefChip, type RefChipKind } from "@/components/chrome/overlays/dialogs/RefChip";

type Ref = { name: string; kind: RefChipKind };

/** Names the dragged ref and the drop target once, so rows can stay verb-only. */
export function DropMenuHeader({ from, to }: { from: Ref; to: Ref }) {
  return (
    <div className="mb-1 flex flex-col gap-1.5 border-b border-black/5 px-2 pb-2.5 pt-1.5 dark:border-white/5">
      {([["Drag", from], ["Onto", to]] as const).map(([label, ref]) => (
        <div key={label} className="flex min-w-0 items-center gap-2">
          <span className="w-[30px] flex-none text-[11px] font-medium text-neutral-400">{label}</span>
          <RefChip name={ref.name} kind={ref.kind} />
        </div>
      ))}
    </div>
  );
}
