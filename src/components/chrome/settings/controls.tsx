// Small controls shared across more than one settings panel. One-off controls
// stay co-located in their panel; these earn a shared home because both the
// General and Repository Identity panels render them.

/** Uppercase section heading above a group of settings controls. */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-[11px] text-[11px] font-bold tracking-[0.05em] text-neutral-500 dark:text-neutral-400">
      {children}
    </div>
  );
}
