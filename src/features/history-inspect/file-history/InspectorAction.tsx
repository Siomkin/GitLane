export function InspectorAction({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] text-neutral-700 hover:bg-black/5 dark:text-neutral-200 dark:hover:bg-white/5"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-4 w-4 text-neutral-400">
        {children}
      </svg>
      {label}
    </button>
  );
}
