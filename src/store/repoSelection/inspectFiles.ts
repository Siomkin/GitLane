import { api, type FileChange, type FileDiff, type RepoGraph } from "@/lib/api";
import { inspectParentRangeFromGraph } from "@/lib/inspectParent";
import { repoSessionIsCurrent } from "@/store/repoGuards";
import { publishedRepoSession } from "@/store/repoRequests";
import type { RepoGet, RepoSet, RepoState } from "@/store/repoTypes";

/** File list for the inspector's active parent: first parent stays on
 * `commit_files` (stash union + today's default); any other parent is
 * `diff_range(parent, merge)`. */
export function fetchInspectFileList(
  repoPath: string,
  mergeOid: string,
  parentIndex: number,
  graph: RepoGraph | null,
): Promise<FileChange[]> {
  const range = inspectParentRangeFromGraph(graph, mergeOid, parentIndex);
  return range
    ? api.diffRange(repoPath, range.base, range.head)
    : api.commitFiles(repoPath, mergeOid);
}

/** Per-file hunks matching {@link fetchInspectFileList}. */
export function fetchInspectFileDiff(
  repoPath: string,
  mergeOid: string,
  parentIndex: number,
  graph: RepoGraph | null,
  path: string,
  full?: boolean,
): Promise<FileDiff> {
  const range = inspectParentRangeFromGraph(graph, mergeOid, parentIndex);
  return range
    ? api.diffRangeFile(repoPath, range.base, range.head, path, full)
    : api.commitFileDiff(repoPath, mergeOid, path, full);
}

export function createInspectParentActions(
  set: RepoSet,
  get: RepoGet,
): Pick<RepoState, "setInspectParentIndex"> {
  return {
    setInspectParentIndex: async (index) => {
      const { summary, graph, selectedCommit, stashes, inspectParentIndex } = get();
      if (!summary || !selectedCommit || index === inspectParentIndex) return;
      const commit = graph?.commits.find((node) => node.id === selectedCommit);
      const isStash =
        !!commit?.stash || stashes.some((stash) => stash.oid === selectedCommit);
      if (isStash) return;
      if (index < 0 || (commit && index >= commit.parents.length)) return;

      const repoPath = summary.path;
      const repoSession = publishedRepoSession.current();
      const fileSelectionRequestId = get().fileSelectionRequestId + 1;
      set({
        inspectParentIndex: index,
        fileSelectionRequestId,
        diffLoading: true,
        commitFiles: [],
        selectedFile: null,
        fileDiff: null,
        error: null,
      });
      const fresh = () =>
        repoSessionIsCurrent(get, repoPath, repoSession) &&
        get().fileSelectionRequestId === fileSelectionRequestId &&
        get().selectedCommit === selectedCommit &&
        get().inspectParentIndex === index;
      try {
        const files = await fetchInspectFileList(repoPath, selectedCommit, index, graph);
        if (!fresh()) return;
        set({ commitFiles: files, diffLoading: false });
      } catch (e) {
        if (!fresh()) return;
        set({ diffLoading: false, error: String(e) });
      }
    },
  };
}
