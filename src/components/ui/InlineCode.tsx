// Inline monospace code chip for prose (e.g. `gh auth login`, `claude --model …`).
// Domain-free presentational primitive shared across settings surfaces.

export function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded border border-black/10 bg-black/[0.05] px-1.5 py-px font-mono text-[12px] text-neutral-500 dark:border-white/10 dark:bg-white/[0.06] dark:text-neutral-400">
      {children}
    </code>
  );
}
