import { CheckIcon, CloseIcon, EditIcon, FileIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/features/repo-files/format";
import { FileViewMode } from "./mode";

const segBtn = (active: boolean) =>
  cn(
    "h-6 rounded-md px-2.5",
    active
      ? "bg-white font-medium text-neutral-800 shadow-sm dark:bg-neutral-700 dark:text-neutral-100"
      : "text-neutral-500 dark:text-neutral-400",
  );

/** Source / Preview segmented switcher — matches the changed-files
 * `FileViewToggle` idiom. Rendered only for files that have a rendered form. */
function ModeToggle({ mode, onMode }: { mode: FileViewMode; onMode: (m: FileViewMode) => void }) {
  return (
    <div
      role="group"
      aria-label="File view"
      className="flex rounded-lg bg-black/[0.06] p-0.5 text-[12px] dark:bg-white/[0.06]"
    >
      <button
        type="button"
        aria-pressed={mode === FileViewMode.Source}
        className={segBtn(mode === FileViewMode.Source)}
        onClick={() => onMode(FileViewMode.Source)}
      >
        Source
      </button>
      <button
        type="button"
        aria-pressed={mode === FileViewMode.Preview}
        className={segBtn(mode === FileViewMode.Preview)}
        onClick={() => onMode(FileViewMode.Preview)}
      >
        Preview
      </button>
    </div>
  );
}

export interface FileViewHeaderProps {
  path: string;
  /** Total line count (for the read stats), or null when binary/unavailable. */
  totalLines: number | null;
  /** Byte size for the stats line, or null to hide it. */
  size: number | null;
  showPreview: boolean;
  mode: FileViewMode;
  onMode: (m: FileViewMode) => void;
  editable: boolean;
  editing: boolean;
  dirty: boolean;
  saving: boolean;
  onEdit: () => void;
  onDoneEdit: () => void;
  onSave: () => void;
  onRevert: () => void;
  onClose: () => void;
}

/** The viewer's single header line: file identity + stats on the left, the
 * view/edit controls and close on the right. */
export function FileViewHeader({
  path,
  totalLines,
  size,
  showPreview,
  mode,
  onMode,
  editable,
  editing,
  dirty,
  saving,
  onEdit,
  onDoneEdit,
  onSave,
  onRevert,
  onClose,
}: FileViewHeaderProps) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-black/5 px-3 dark:border-white/5">
      <FileIcon path={path} size={16} />
      <span className="min-w-0 truncate font-mono text-[12.5px] text-neutral-700 dark:text-neutral-200">
        {path}
      </span>
      {dirty && (
        <span
          aria-label="Unsaved changes"
          title="Unsaved changes"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
        />
      )}
      {totalLines != null && size != null && (
        <span className="shrink-0 text-[11px] text-neutral-400">
          {totalLines.toLocaleString()} lines · {formatBytes(size)}
        </span>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {showPreview && !editing && <ModeToggle mode={mode} onMode={onMode} />}

        {editing ? (
          <>
            <button
              type="button"
              onClick={onRevert}
              disabled={!dirty || saving}
              className="h-7 rounded-lg px-2.5 text-[12px] font-medium text-neutral-600 hover:bg-black/5 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-white/5"
            >
              Revert
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={!dirty || saving}
              title="Save (⌘S)"
              className="flex h-7 items-center gap-1 rounded-lg bg-[color:var(--accent)] px-2.5 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-40"
            >
              <CheckIcon width={11} height={11} />
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={onDoneEdit}
              disabled={saving}
              className="h-7 rounded-lg px-2.5 text-[12px] font-medium text-neutral-600 hover:bg-black/5 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-white/5"
            >
              Done
            </button>
          </>
        ) : (
          editable &&
          mode === FileViewMode.Source && (
            <button
              type="button"
              onClick={onEdit}
              className="flex h-7 items-center gap-1 rounded-lg px-2.5 text-[12px] font-medium text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
            >
              <EditIcon width={12} height={12} />
              Edit
            </button>
          )
        )}

        <button
          type="button"
          onClick={onClose}
          // Frozen during a save so a discard confirm can't claim the edits were
          // dropped while the in-flight write actually commits them to disk.
          disabled={saving}
          aria-label="Close file"
          className="grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-black/5 hover:text-neutral-600 disabled:opacity-40 dark:hover:bg-white/5 dark:hover:text-neutral-200"
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    </header>
  );
}
