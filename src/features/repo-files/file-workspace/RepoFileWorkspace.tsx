import { useMemo, useState } from "react";
import { FileIcon, WarningIcon } from "../../../components/ui/icons";
import { languageForPath } from "../../../lib/highlight";
import { useRepo } from "../../../store/repo";
import { DISCARD_UNSAVED_CONFIRM, isFileViewDirty, isFileViewEditable } from "../../../store/repoFilesActions";
import { useUi } from "../../../store/ui";
import { formatBytes, splitLinesCapped, utf8Bytes } from "../format";
import { computeLineChangesText } from "./lineChanges";
import { FileEditor } from "./FileEditor";
import { FilePreview } from "./FilePreview";
import { FileSourceView } from "./FileSourceView";
import { FileViewHeader } from "./FileViewHeader";
import { FileViewMode, hasPreview } from "./mode";

/** Upper bound on lines rendered at once in the read-only source view. One DOM
 * row + tokenizer pass per line would freeze the webview on a file with hundreds
 * of thousands of short lines (well within the backend's 2 MiB byte cap). Beyond
 * this we render the head and show a notice. Editing uses a single textarea, so
 * it is not bound by this. */
const MAX_RENDER_LINES = 20_000;

/** Center pane: one repository file opened from the Files tab — read-only source
 * by default (GL-211), with per-language highlighting, a Markdown preview, and
 * in-app editing (GL-212). */
export function RepoFileWorkspace() {
  const fileView = useRepo((s) => s.fileView);
  const openRepoFile = useRepo((s) => s.openRepoFile);
  const closeRepoFile = useRepo((s) => s.closeRepoFile);
  const beginFileEdit = useRepo((s) => s.beginFileEdit);
  const updateFileDraft = useRepo((s) => s.updateFileDraft);
  const revertFileEdit = useRepo((s) => s.revertFileEdit);
  const endFileEdit = useRepo((s) => s.endFileEdit);
  const saveFileEdit = useRepo((s) => s.saveFileEdit);
  const requestConfirm = useUi((s) => s.requestConfirm);

  const path = fileView?.path ?? "";
  const editing = !!fileView?.edit;
  const dirty = isFileViewDirty(fileView);
  const editable = isFileViewEditable(fileView);
  const showPreview = !!fileView && hasPreview(path);

  // Per-file view mode without an effect: the stored mode only applies while the
  // same path is open, so switching files falls back to Source automatically.
  const [view, setView] = useState<{ path: string; mode: FileViewMode }>({ path: "", mode: FileViewMode.Source });
  const mode = view.path === path ? view.mode : FileViewMode.Source;
  const setMode = (m: FileViewMode) => setView({ path, mode: m });
  // Editing always shows Source; Preview only exists for previewable files.
  const effectiveMode = editing || !showPreview ? FileViewMode.Source : mode;

  const lang = useMemo(() => languageForPath(path), [path]);

  // Split only the head that renders (the read-only source view).
  const { lines: shownLines, total: totalLines } = useMemo(
    () => splitLinesCapped(fileView?.content?.text ?? "", MAX_RENDER_LINES),
    [fileView?.content?.text],
  );

  // Uncommitted changes for the read-only Source view: the on-disk text vs the
  // committed baseline (the editor computes its own from the live draft instead).
  const baseline = fileView?.baseline ?? null;
  const sourceText = fileView?.content?.text ?? "";
  // Counts lines before splitting, so a newline-dense file over the cap doesn't
  // allocate the line arrays just to be rejected.
  const sourceChanges = useMemo(
    () => (baseline == null ? null : computeLineChangesText(baseline, sourceText)),
    [baseline, sourceText],
  );

  if (!fileView) return null;
  const content = fileView.content;

  const guardedDiscard = (run: () => void) => {
    if (!dirty) {
      run();
      return;
    }
    requestConfirm({
      ...DISCARD_UNSAVED_CONFIRM,
      // Re-check at confirm time: a ⌘S between opening this dialog and confirming
      // it starts an uncancellable write, so "Discard" must not then close/end the
      // edit while that write commits (Close/Done buttons are disabled during a
      // save, but ⌘S is a window shortcut that can fire while the dialog is open).
      onConfirm: () => {
        if (useRepo.getState().fileView?.edit?.saving) return;
        run();
      },
    });
  };

  return (
    <section
      aria-label={`File ${fileView.path}`}
      className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-black/5 bg-white shadow-sm dark:border-white/5 dark:bg-neutral-800"
    >
      <FileViewHeader
        path={fileView.path}
        totalLines={content && !content.binary ? totalLines : null}
        size={content && !content.binary ? content.size : null}
        showPreview={showPreview}
        mode={mode}
        onMode={setMode}
        editable={editable}
        editing={editing}
        dirty={dirty}
        saving={!!fileView.edit?.saving}
        onEdit={() => {
          setMode(FileViewMode.Source);
          beginFileEdit();
        }}
        onDoneEdit={() => guardedDiscard(endFileEdit)}
        onSave={() => void saveFileEdit()}
        onRevert={revertFileEdit}
        onClose={() => guardedDiscard(closeRepoFile)}
      />

      {!editing && effectiveMode === FileViewMode.Source && content?.truncated && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-amber-500/15 bg-amber-500/[0.08] px-3 text-[12px] text-amber-700 dark:text-amber-300">
          <WarningIcon className="h-3.5 w-3.5 shrink-0" />
          Large file — showing the first {formatBytes(utf8Bytes(content.text ?? ""))} of {formatBytes(content.size)}.
          Read-only.
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {fileView.loading ? (
          <div className="space-y-1 p-3">
            {Array.from({ length: 16 }).map((_, i) => (
              <div key={i} className="shim h-[18px] rounded bg-black/[0.05] dark:bg-white/[0.06]" />
            ))}
          </div>
        ) : fileView.error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-neutral-400">
            <p className="text-[13px] font-medium text-neutral-600 dark:text-neutral-300">Couldn't read this file.</p>
            <p className="max-w-full truncate text-[12px]">{fileView.error}</p>
            <button
              type="button"
              onClick={() => void openRepoFile(fileView.path)}
              className="mt-1 h-8 rounded-lg bg-[color:var(--accent)] px-3.5 text-[12px] font-semibold text-white hover:brightness-110"
            >
              Retry
            </button>
          </div>
        ) : content?.binary ? (
          <div className="flex h-full flex-col items-center justify-center gap-2.5 px-6 text-center text-neutral-400">
            <FileIcon path={fileView.path} size={36} />
            <p className="text-[13px] font-medium text-neutral-600 dark:text-neutral-300">Binary file — no text preview.</p>
            <p className="font-mono text-[12px]">{formatBytes(content.size)}</p>
          </div>
        ) : editing && fileView.edit ? (
          <FileEditor
            draft={fileView.edit.draft}
            dirty={dirty}
            saving={fileView.edit.saving}
            error={fileView.edit.error}
            lang={lang}
            baseline={fileView.baseline ?? null}
            onChange={updateFileDraft}
            onSave={() => void saveFileEdit()}
          />
        ) : effectiveMode === FileViewMode.Preview ? (
          <FilePreview text={content?.text ?? ""} />
        ) : (
          <FileSourceView
            shownLines={shownLines}
            totalLines={totalLines}
            maxRenderLines={MAX_RENDER_LINES}
            lang={lang}
            changes={sourceChanges}
          />
        )}
      </div>
    </section>
  );
}
