import { ChevronRightIcon, FileIcon, FolderIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { basename } from "@/lib/paths";

/** Indent per tree depth level, in px. */
const INDENT = 14;

const rowBase =
  "flex h-[26px] w-full items-center gap-1.5 px-2 text-left text-[12.5px] " +
  "text-neutral-700 hover:bg-black/[0.04] dark:text-neutral-200 dark:hover:bg-white/[0.05]";

/** A collapsible directory header row in the Files tree. */
export function DirRow({
  label,
  depth,
  expanded,
  onToggle,
}: {
  label: string;
  depth: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className={rowBase}
      style={{ paddingLeft: 8 + depth * INDENT }}
    >
      <ChevronRightIcon
        className={cn(
          "h-3 w-3 shrink-0 text-neutral-400 transition-transform",
          expanded && "rotate-90",
        )}
      />
      <FolderIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

/** A file leaf row. `fullPath` shows the whole repo-relative path (the filter's
 * flat match list); otherwise just the basename at its tree depth. */
export function FileRow({
  path,
  depth,
  active,
  fullPath = false,
  onOpen,
}: {
  path: string;
  depth: number;
  active: boolean;
  fullPath?: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active || undefined}
      onClick={onOpen}
      title={path}
      className={cn(rowBase, active && "bg-[var(--accent-soft)] font-medium")}
      // Files sit one chevron-width in from their parent directory's label.
      style={{ paddingLeft: 8 + depth * INDENT + 18 }}
    >
      <FileIcon path={path} size={15} />
      <span className="min-w-0 truncate">{fullPath ? path : basename(path)}</span>
    </button>
  );
}
