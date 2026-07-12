import { api } from "../lib/api";
import { useUi } from "./ui";
import type { RepoGet, RepoSet, RepoState } from "./repoTypes";

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
): Pick<RepoState, "loadRepoFiles" | "openRepoFile" | "reloadFileView" | "closeRepoFile"> {
  // Per-store generation counters. Only the newest request may publish; a
  // superseded in-flight response (older generation) is dropped on arrival.
  let listGen = 0;
  let viewGen = 0;
  let reloadGen = 0;

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
      set({ compare: null, fileHistory: null, fileView: { path, content: null, loading: true, error: null } });
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
      } catch (e) {
        if (!fresh()) return;
        // Only a genuinely-gone file dismisses the viewer (e.g. it doesn't exist
        // on the newly checked-out branch); a transient read error keeps the
        // last-good content rather than closing it out from under the user.
        if (isMissingFileError(e)) set({ fileView: null });
      }
    },

    closeRepoFile: () => set({ fileView: null }),
  };
}
