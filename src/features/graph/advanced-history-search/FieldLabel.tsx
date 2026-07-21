export function FieldLabel({
  children,
  trailing,
}: {
  children: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  // A fixed-height label row keeps every input in the grid on the same line —
  // the "Changed code" cell packs its match-mode toggle into this row, which
  // would otherwise make it taller than its neighbours' and push its input down.
  return (
    <span className="mb-1 flex h-5 items-center justify-between">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
        {children}
      </span>
      {trailing}
    </span>
  );
}
