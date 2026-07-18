import type { FileChange } from "@/lib/api";
import { basename, dirname } from "@/lib/paths";
import { ChangeCounts } from "@/components/ui/ChangeCounts";
import { FileIcon } from "@/components/ui/icons";
import { StatusPill } from "@/components/ui/StatusBadge";

export function StackedFileHeader({
  file,
  open,
  active,
  onToggle,
}: {
  file: FileChange;
  open: boolean;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      data-file-path={file.path}
      className={`flex h-11 w-full items-center gap-2 border-b border-black/5 px-4 text-left dark:border-white/5 ${
        active
          ? "bg-[var(--accent-soft)]"
          : "bg-white dark:bg-neutral-800"
      }`}
      onClick={onToggle}
    >
      <span className="w-3 flex-none text-[10px] text-neutral-400">{open ? "▾" : "▸"}</span>
      <span className="text-[color:var(--accent)]">
        <FileIcon path={file.path} size={20} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px]">
        <span className="text-neutral-400">{dirname(file.path)}</span>
        <strong className="font-semibold text-neutral-800 dark:text-neutral-100">
          {basename(file.path)}
        </strong>
      </span>
      <StatusPill status={file.status} />
      <ChangeCounts
        add={file.add}
        del={file.del}
        binary={file.binary}
        addAtLeast={file.lineCountTruncated}
        className="text-[11px]"
      />
    </button>
  );
}
