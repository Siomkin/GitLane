export function PaginationNotice({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="mb-2.5 rounded-lg border border-amber-500/20 bg-amber-500/[0.07] px-3 py-2 text-[12px] leading-5 text-amber-700 dark:text-amber-300"
    >
      {children}
    </div>
  );
}
