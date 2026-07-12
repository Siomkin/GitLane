import { cn } from "@/lib/cn";
import { basename, dirname } from "@/lib/paths";
import type { OperationFile } from "@/store/repo";

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="h-3 w-3">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

const WarnDot = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3">
    <path d="M12 8v5M12 16h.01" />
    <circle cx="12" cy="12" r="9" />
  </svg>
);

const kindSuffix = (file: OperationFile) =>
  file.kind === "deleted"
    ? file.deletedSide === "both"
      ? " · deleted by both"
      : file.deletedSide === "ours"
        ? " · deleted by you"
        : " · deleted by them"
    : file.kind === "binary"
      ? " · binary"
      : "";

export const ConflictFileRow = ({
  file,
  selected,
  oursSub,
  theirsSub,
  onOpen,
  onAcceptOurs,
  onAcceptTheirs,
}: {
  file: OperationFile;
  selected: boolean;
  /** Operation-aware side labels (rebase inverts ours/theirs) for the button
   * tooltips, so resolving from the list can't pick the opposite side. */
  oursSub: string;
  theirsSub: string;
  onOpen: () => void;
  onAcceptOurs: () => void;
  onAcceptTheirs: () => void;
}) => {
  const dir = dirname(file.path);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open conflict in ${file.path}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "group relative flex h-12 cursor-pointer items-center gap-2.5 rounded-lg pl-2.5 pr-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
        selected ? "bg-[var(--accent-soft)]" : "hover:bg-black/5 dark:hover:bg-white/5",
      )}
    >
      <div
        className={cn(
          "grid h-5 w-5 shrink-0 place-items-center rounded-full",
          file.resolved
            ? "bg-[var(--accent)] text-white"
            : "bg-amber-100 text-amber-600 dark:bg-amber-400/15 dark:text-amber-300",
        )}
      >
        {file.resolved ? <CheckIcon /> : <WarnDot />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] leading-tight text-neutral-800 dark:text-neutral-100">
          {basename(file.path)}
        </div>
        <div className="truncate text-[11px] leading-tight text-neutral-400">
          {dir}
          {kindSuffix(file)}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {file.kind === "deleted" && (
          <span className="grid h-4 place-items-center rounded bg-rose-500/15 px-1 text-[9px] font-bold text-rose-500 group-hover:hidden">
            del
          </span>
        )}
        {file.kind === "binary" && (
          <span className="grid h-4 place-items-center rounded bg-neutral-400/20 px-1 text-[9px] font-bold text-neutral-500 group-hover:hidden">
            bin
          </span>
        )}
        {file.resolved ? (
          <span className="hidden text-[10px] font-semibold text-[color:var(--accent)] group-hover:inline">
            resolved
          </span>
        ) : (
          <div className="hidden items-center gap-1 group-hover:flex">
            <button type="button"
              onClick={(e) => {
                e.stopPropagation();
                onAcceptOurs();
              }}
              onKeyDown={(e) => e.stopPropagation()}
              title={`Accept ${oursSub}`}
              aria-label={`Accept ${oursSub} for ${file.path}`}
              className="h-6 rounded-md bg-[var(--accent-soft)] px-1.5 text-[10px] font-semibold text-[color:var(--accent)] hover:brightness-95"
            >
              Ours
            </button>
            <button type="button"
              onClick={(e) => {
                e.stopPropagation();
                onAcceptTheirs();
              }}
              onKeyDown={(e) => e.stopPropagation()}
              title={`Accept ${theirsSub}`}
              aria-label={`Accept ${theirsSub} for ${file.path}`}
              className="h-6 rounded-md bg-[#3b7ff5]/[0.12] px-1.5 text-[10px] font-semibold text-[#3b7ff5] hover:brightness-95"
            >
              Theirs
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
