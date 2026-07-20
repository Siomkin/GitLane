import { api } from "@/lib/api";
import { useUi } from "./ui";
import type { FileViewState, RepoGet, RepoSet, RepoState } from "./repoTypes";

/** Shared copy for the "you have unsaved edits" confirmation, used both when
 * closing/leaving the editor and when opening another file over a dirty one. */
export const DISCARD_UNSAVED_CONFIRM = {
  title: "Discard unsaved changes?",
  message: "Your edits to this file haven't been saved.",
  confirmLabel: "Discard",
  danger: true,
} as const;

/** Whether the file's editable buffer diverges from its last-saved text. Derived
 * (not stored) so a save that republishes `content.text` clears it for free. */
export const isFileViewDirty = (fileView: FileViewState | null): boolean =>
  !!fileView?.edit && fileView.edit.draft !== (fileView.content?.text ?? "");

/** Whether a file's current content can be edited in place. Truncated (>2 MiB)
 * and binary reads are refused: the buffer holds only a prefix (or no text), so
 * saving it would destroy the unseen remainder. */
export const isFileViewEditable = (fileView: FileViewState | null): boolean =>
  !!fileView?.content &&
  !fileView.content.binary &&
  !fileView.content.truncated &&
  fileView.content.text != null &&
  typeof fileView.content.expectedState === "string" &&
  fileView.content.expectedState.length > 0;

/** Whether a `repo_file_text` failure means the file is gone (absent on the
 * newly checked-out branch, deleted, or replaced by a non-regular entry) versus
 * a transient read error. A gone file dismisses the viewer; a transient error
 * leaves the last-good content on screen. */
const isMissingFileError = (e: unknown): boolean =>
  /no such file|not found|cannot find|does not exist|enoent|non-regular/i.test(String(e));

/** The Files browser: the right panel's repository file listing and the
 * read-only file view it opens in the center pane. Both are repo-bound and
 * fetched behind monotonic request-generation guards so an older response can
 * never overwrite a newer one — watcher-driven reloads and rapid re-clicks can
 * complete out of order (repo-path identity alone can't tell them apart, since
 * reopening the same file keeps the same path). */
export function createRepoFilesActions(
  set: RepoSet,
  get: RepoGet,
): Pick<
  RepoState,
  | "loadRepoFiles"
  | "openRepoFile"
  | "requestOpenRepoFile"
  | "reloadFileView"
  | "closeRepoFile"
  | "beginFileEdit"
  | "updateFileDraft"
  | "revertFileEdit"
  | "endFileEdit"
  | "saveFileEdit"
> {
  // Per-store generation counters. Only the newest request may publish; a
  // superseded in-flight response (older generation) is dropped on arrival.
  let listGen = 0;
  let viewGen = 0;
  let reloadGen = 0;
  let saveGen = 0;
  let baselineGen = 0;

  // Fetch the committed (HEAD) baseline for the uncommitted-change gutter/ruler
  // and attach it to the open file — best-effort (a failure just means no
  // markers) and fired after the content read so it never perturbs the content
  // freshness guards. Guarded so a slow response can't attach to a different
  // file. Kept separate (not Promise.all with the content read) so the content
  // read's request sequencing is unchanged.
  const fetchBaseline = (repoPath: string, path: string) => {
    // A generation guard so an older baseline read (a prior open/reload/edit on
    // the same path, e.g. across an external HEAD move) can't overwrite a newer
    // one — path identity alone can't tell two requests apart.
    const gen = ++baselineGen;
    void Promise.resolve(api.repoFileHeadText(repoPath, path))
      .then((baseline) => {
        if (typeof baseline !== "string" && baseline !== null) return; // only a real string / null
        const cur = get().fileView;
        if (gen === baselineGen && get().summary?.path === repoPath && cur?.path === path) {
          set({ fileView: { ...cur, baseline } });
        }
      })
      .catch(() => {});
  };

  return {
    loadRepoFiles: async () => {
      const { summary } = get();
      if (!summary) return;
      const repoPath = summary.path;
      const gen = ++listGen;
      // Keep the previous listing visible while reloading (watcher refreshes
      // would otherwise flash the tree empty on every worktree change).
      set((s) => ({
        repoFiles: { files: s.repoFiles?.files ?? [], loading: true, error: null },
      }));
      // Also require the slice to still be present: a repo switch / tab close /
      // missing-repo reset nulls `repoFiles` without bumping `listGen`, so a
      // response that resolves after such a reset (same path, same generation)
      // must not republish — otherwise it sticks, since FilesPanel only reloads
      // when `repoFiles` is null.
      const fresh = () =>
        gen === listGen && get().summary?.path === repoPath && get().repoFiles !== null;
      try {
        const files = await api.listRepoFiles(repoPath);
        if (!fresh()) return;
        set({ repoFiles: { files, loading: false, error: null } });
      } catch (e) {
        if (!fresh()) return;
        set((s) => ({
          repoFiles: { files: s.repoFiles?.files ?? [], loading: false, error: String(e) },
        }));
      }
    },

    openRepoFile: async (path) => {
      const { summary } = get();
      if (!summary) return;
      const repoPath = summary.path;
      const gen = ++viewGen;
      // Opening a file is an explicit center-pane route: clear the sibling
      // inspection surfaces that outrank "file" in deriveCenterView (compare,
      // file history, stacked review) so the file actually surfaces instead of
      // silently waiting behind them. (The pulls tab still outranks it — the
      // Files affordances aren't reachable there.)
      set((state) => ({
        fileSelectionRequestId: state.fileSelectionRequestId + 1,
        compare: null,
        fileHistory: null,
        fileView: { path, content: null, loading: true, error: null },
      }));
      useUi.getState().closeStackedReview();
      // Require the open file to still be *this* path: `closeRepoFile`,
      // `returnToGraph`, and lifecycle resets clear/replace `fileView` without
      // bumping `viewGen`, so a slow response that resolves after the user
      // closed the file (or opened another) must not resurrect the viewer.
      const fresh = () =>
        gen === viewGen && get().summary?.path === repoPath && get().fileView?.path === path;
      try {
        const content = await api.repoFileText(repoPath, path);
        if (!fresh()) return;
        set({ fileView: { path, content, loading: false, error: null } });
        fetchBaseline(repoPath, path);
      } catch (e) {
        if (!fresh()) return;
        set({ fileView: { path, content: null, loading: false, error: String(e) } });
      }
    },

    reloadFileView: async () => {
      const { summary, fileView } = get();
      if (!summary || !fileView) return;
      const repoPath = summary.path;
      const path = fileView.path;
      // Never re-read the content under an open edit session — a watcher tick
      // (including the one our own save fires) would otherwise clobber the draft.
      // The baseline is still refreshed so the change gutter re-diffs against a
      // HEAD moved by an external commit/checkout mid-edit.
      if (fileView.edit) {
        fetchBaseline(repoPath, path);
        return;
      }
      // Defer to a user-driven open (capture `viewGen`, don't bump — a newer
      // `openRepoFile` bumps it and supersedes this) and to any newer reload
      // (bump `reloadGen`), so the freshest read always wins and a slower older
      // reload can't overwrite it. No loading flip — the current content stays
      // on screen until the fresh read lands.
      const vg = viewGen;
      const rg = ++reloadGen;
      const fresh = () =>
        vg === viewGen &&
        rg === reloadGen &&
        get().summary?.path === repoPath &&
        get().fileView?.path === path;
      try {
        const content = await api.repoFileText(repoPath, path);
        if (!fresh()) return;
        set({ fileView: { path, content, loading: false, error: null } });
        // Re-read the baseline too — a checkout/commit moves HEAD.
        fetchBaseline(repoPath, path);
      } catch (e) {
        if (!fresh()) return;
        // Only a genuinely-gone file dismisses the viewer (e.g. it doesn't exist
        // on the newly checked-out branch); a transient read error keeps the
        // last-good content rather than closing it out from under the user.
        if (isMissingFileError(e)) {
          set((state) => ({
            fileSelectionRequestId: state.fileSelectionRequestId + 1,
            fileView: null,
          }));
        }
      }
    },

    requestOpenRepoFile: (path) => {
      const fileView = get().fileView;
      // Ignore navigation while a save is committing: a discard confirm here would
      // claim the edits were dropped while the (uncancellable) write still lands
      // on disk. The write is near-instant, so the click just no-ops; retry after.
      if (fileView?.edit?.saving) return;
      // Guard the one navigation the in-viewer confirm can't reach: picking
      // another file (Files panel row, file context menu) over a dirty editor.
      if (isFileViewDirty(fileView)) {
        useUi.getState().requestConfirm({
          ...DISCARD_UNSAVED_CONFIRM,
          // Re-check at execution time: a ⌘S between opening this dialog and
          // confirming it must not let navigation proceed while the write lands.
          onConfirm: () => {
            if (get().fileView?.edit?.saving) return;
            void get().openRepoFile(path);
          },
        });
      } else {
        void get().openRepoFile(path);
      }
    },

    closeRepoFile: () =>
      set((state) => ({
        fileSelectionRequestId: state.fileSelectionRequestId + 1,
        fileView: null,
      })),

    beginFileEdit: () => {
      const { summary, fileView } = get();
      if (!fileView || !isFileViewEditable(fileView) || fileView.edit) return;
      // Starting a new edit session invalidates any still-in-flight save from a
      // previous one on the same path (close → reopen → edit), so its late
      // response can't publish into this fresh session.
      saveGen++;
      set({
        fileView: {
          ...fileView,
          edit: {
            draft: fileView.content!.text ?? "",
            baseSize: fileView.content!.size,
            baseExpectedState: fileView.content!.expectedState!,
            saving: false,
            error: null,
          },
        },
      });
      // Refresh the baseline on edit entry so the change gutter reflects any
      // checkout since the file was opened.
      if (summary?.path) fetchBaseline(summary.path, fileView.path);
    },

    updateFileDraft: (text) => {
      const { fileView } = get();
      if (!fileView?.edit) return;
      set({ fileView: { ...fileView, edit: { ...fileView.edit, draft: text, error: null } } });
    },

    revertFileEdit: () => {
      const { fileView } = get();
      if (!fileView?.edit) return;
      set({
        fileView: {
          ...fileView,
          edit: { ...fileView.edit, draft: fileView.content?.text ?? "", error: null },
        },
      });
    },

    endFileEdit: () => {
      const { fileView } = get();
      if (!fileView?.edit) return;
      set({ fileView: { ...fileView, edit: null } });
    },

    saveFileEdit: async () => {
      const { summary, fileView } = get();
      if (!summary || !fileView?.edit || !fileView.content) return;
      if (fileView.edit.saving) return;
      const repoPath = summary.path;
      const path = fileView.path;
      const draft = fileView.edit.draft;
      const baseSize = fileView.edit.baseSize;
      const baseExpectedState = fileView.edit.baseExpectedState;
      // A monotonic guard so a response can't publish into a *different* edit
      // session — closing and reopening the same path mid-save bumps this, and
      // the stale result is dropped. (The textarea is read-only while saving, so
      // the captured `draft` can't go stale under the in-flight write.)
      const gen = ++saveGen;
      set({ fileView: { ...fileView, edit: { ...fileView.edit, saving: true, error: null } } });
      try {
        const result = await api.writeRepoFile(repoPath, path, draft, baseSize, baseExpectedState);
        // Only publish if the same file is still open in the same save session.
        const cur = get().fileView;
        if (gen !== saveGen || get().summary?.path !== repoPath || cur?.path !== path || !cur?.edit) return;
        // Republish the saved text as the clean baseline: `content.text` now
        // equals the draft (dirty clears), and both lease fields advance so a
        // second save guards the bytes produced by this one.
        set({
          fileView: {
            ...cur,
            content: cur.content
              ? { ...cur.content, text: draft, size: result.size, expectedState: result.expectedState }
              : cur.content,
            edit: {
              ...cur.edit,
              baseSize: result.size,
              baseExpectedState: result.expectedState,
              saving: false,
              error: null,
            },
          },
        });
      } catch (e) {
        const cur = get().fileView;
        if (gen !== saveGen || get().summary?.path !== repoPath || cur?.path !== path || !cur?.edit) return;
        set({ fileView: { ...cur, edit: { ...cur.edit, saving: false, error: String(e) } } });
      }
    },
  };
}
