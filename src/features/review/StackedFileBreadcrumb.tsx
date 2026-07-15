import type { FileChange } from "@/lib/api";
import { FileIcon } from "@/components/ui/icons";
import { StatusPill } from "@/components/ui/StatusBadge";
import { basename, dirname } from "@/lib/paths";

/** Compact sticky context bar shown while a file's body crosses the viewport
 * top. Clicking it stands in for the old always-sticky header's affordance:
 * collapse the file and return to its header row. */
export function StackedFileBreadcrumb({
  file,
  onCollapse,
}: {
  file: FileChange;
  onCollapse: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="stacked-file-breadcrumb"
      aria-label={`Collapse ${file.path}`}
      title="Collapse this file"
      onClick={onCollapse}
      className="pointer-events-auto flex h-8 w-full items-center gap-2 border-b border-black/10 bg-white px-4 text-left shadow-sm hover:bg-black/[0.03] dark:border-white/10 dark:bg-neutral-800 dark:hover:bg-white/[0.04]"
    >
      <span className="w-3 flex-none text-[10px] text-neutral-400">▾</span>
      <span className="text-[color:var(--accent)]">
        <FileIcon path={file.path} size={16} />
      </span>
      <span className="min-w-0 flex-1 truncate text-xs">
        <span className="text-neutral-400">{dirname(file.path)}</span>
        <strong className="font-semibold text-neutral-800 dark:text-neutral-100">
          {basename(file.path)}
        </strong>
      </span>
      <StatusPill status={file.status} />
    </button>
  );
}
