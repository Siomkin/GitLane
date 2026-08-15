import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cellMatcher, printsOf } from "./conflictResolver/keys";
import { useDecisionEditing } from "./conflictResolver/useDecisionEditing";
// eslint-disable-next-line no-restricted-imports -- feature hook owning the conflict-resolution flow (architecture-rules-react.md §1)
import { api, type ConflictFileContent } from "@/lib/api";
import type { OperationState } from "@/store/repo";
import { useUi } from "@/store/ui";
import { type HunkChoice, type WholeDecision } from "./conflictModel";

/** The conflicted worktree copy, or — once the file is staged — the resolved
 * text as it now sits in the worktree, so the editor can show the final result
 * instead of an empty pane. */
async function readSelectedContent(
  repoPath: string,
  file: string,
  staged: boolean,
): Promise<ConflictFileContent> {
  if (!staged) return api.conflictFile(repoPath, file);
  const result = await api.repoFileText(repoPath, file);
  return {
    path: file,
    content: result.text ?? "",
    binary: result.binary || result.truncated || result.text === undefined,
  };
}

export type EditorMode = "inline" | "split";

/** Stable stand-in while no operation is active, so derived values and effect
 * inputs don't churn identity on every no-operation render. */
const EMPTY_FILES: OperationState["files"] = [];

export interface ConflictResolver {
  mode: EditorMode;
  setMode: (mode: EditorMode) => void;
  selected: string | null;
  select: (path: string) => void;
  /** Conflicted content for the selected file (text kind), or null while it
   * loads / for non-text files. */
  content: ConflictFileContent | null;
  contentLoading: boolean;
  /** Cached content for any previously-opened file (used by "Stage all"). */
  contentFor: (path: string) => ConflictFileContent | undefined;
  /** The one in-progress resolution per hunk — a whole side, a line selection,
   * or custom (rewritten) text, each carrying the fingerprint of the hunk it
   * was made against — keyed by `path::idx` (GL-180). Fresh content
   * invalidates only mismatching cells here; stage-time validation re-checks
   * them against the disk copy so a choice can never apply to a hunk that
   * changed under it. */
  choices: Record<string, HunkChoice>;
  /** Re-fetch one file's conflicted content from disk, refresh the cache, and
   * invalidate decisions whose hunk changed (GL-180). Returns the fresh
   * content, or null when there is no repo / the read fails (prior content and
   * decisions are kept). Staging paths call this immediately before writing. */
  revalidate: (path: string) => Promise<ConflictFileContent | null>;
  decide: (path: string, idx: number, decision: WholeDecision) => void;
  /** Replace a hunk's line selection (the line editor's single mutation). An
   * empty set clears the hunk back to undecided; a non-empty set supersedes any
   * whole-hunk decision. */
  setLineSelection: (path: string, idx: number, selection: Set<string>) => void;
  /** Resolve a hunk with literal lines (an empty array = keep nothing). */
  setCustomResolution: (path: string, idx: number, lines: string[]) => void;
  /** Whole-file resolution when an agent rewrite cannot be mapped onto hunks.
   * `from` is the conflicted body it was produced from (GL-180). */
  fileText: Record<string, { text: string; from: string }>;
  setFileResolution: (path: string, text: string, from: string) => void;
  undo: (path: string, idx: number) => void;
  /** Drop all local decisions for a file (after it's staged/unstaged). */
  resetFile: (path: string) => void;
  confirmAbort: boolean;
  setConfirmAbort: (open: boolean) => void;
}

/**
 * Owns the *local, transient* conflict-editing UI state for the ConflictWorkspace:
 * which file is open, the view mode, per-hunk decisions/line-picks, the
 * conflicted-content cache, and the abort-confirm flag. The durable result
 * (a resolved + staged file) lives in the repo store — this hook only holds the
 * in-progress choices until the user stages them.
 *
 * `api.conflictFile` is fetched here because, like the diff cache in
 * `ChangesWorkspace`, conflicted content is a transient per-file probe, not
 * shared repo state — the hook is the boundary the components consume.
 */
export function useConflictResolver(
  operation: OperationState | null,
  repoPath: string | null,
): ConflictResolver {
  const [mode, setMode] = useState<EditorMode>("inline");
  const [selected, setSelected] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, HunkChoice>>({});
  const [fileText, setFileText] = useState<Record<string, { text: string; from: string }>>({});
  const [confirmAbort, setConfirmAbort] = useState(false);
  const [cache, setCache] = useState<Record<string, ConflictFileContent>>({});
  const [contentLoading, setContentLoading] = useState(false);

  const files = operation?.files ?? EMPTY_FILES;
  const firstUnresolved = files.find((f) => !f.resolved)?.path ?? files[0]?.path ?? null;

  // Default-select the first outstanding conflict, and keep a valid selection as
  // files resolve/leave the set. A still-valid manual selection is preserved.
  // Keyed by the file-path set and the first outstanding conflict — explicit
  // identities, not array identity — so a worktree refresh that changes neither
  // never re-runs the transition. JSON-encoded so no legal filename (newlines
  // included) can collide with a delimiter.
  const filePaths = JSON.stringify(files.map((f) => f.path));
  useEffect(() => {
    const valid = new Set<string>(JSON.parse(filePaths) as string[]);
    setSelected((prev) => (prev && valid.has(prev) ? prev : firstUnresolved));
  }, [filePaths, firstUnresolved]);

  // Fetch the selected text file's content (cached). Deleted/binary files carry
  // their own card and need no marker content. A *resolved* file is read from
  // the worktree instead: `conflict_file` refuses a path that is no longer
  // unmerged, which left the pane blank exactly when the user wanted to see the
  // result they just staged.
  const selectedFile = files.find((f) => f.path === selected) ?? null;
  const needsContent = !!selected && selectedFile?.kind === "text";
  const stagedResult = !!selectedFile?.resolved;
  const cached = selected ? cache[selected] : undefined;
  const fetchTokenRef = useRef(0);

  // Per-path fetch sequence: only the newest in-flight read of a path may apply
  // its result, so an older primary/background response landing late can never
  // clobber the content — or prune decisions against an obsolete snapshot —
  // that a newer read (e.g. a stage-time revalidate) just applied (GL-180
  // review). `beginFetch` claims the newest slot and returns an "am I still
  // newest?" probe for the response handler.
  const fetchSeqRef = useRef<Record<string, number>>({});
  const beginFetch = useCallback((path: string) => {
    const seq = (fetchSeqRef.current[path] ?? 0) + 1;
    fetchSeqRef.current[path] = seq;
    return () => fetchSeqRef.current[path] === seq;
  }, []);

  // Latest-value ref: async work (fetch handlers, the revalidation transition,
  // click handlers) reads the values current at that moment without turning
  // them into effect triggers or callback dependencies.
  const latestInputs = useRef({ files, selected, cache, choices });
  useEffect(() => {
    latestInputs.current = { files, selected, cache, choices };
  });

  // Store freshly-fetched content and invalidate the choices whose hunk no
  // longer matches the fingerprint they were made against (GL-180) — an
  // external edit to one hunk must not leave a choice silently applying to
  // different lines, while untouched hunks keep their choices (a watcher
  // refresh with unchanged content discards nothing). Every content arrival
  // funnels through here: first load, background revalidation, and the
  // stage-time revalidate().
  const applyFresh = useCallback((path: string, content: ConflictFileContent) => {
    setCache((c) => ({ ...c, [path]: content }));
    setFileText((f) => {
      const cur = f[path];
      if (!cur || cur.from === content.content) return f;
      const next = { ...f };
      delete next[path];
      return next;
    });
    const fresh = printsOf(path, content);
    const isCell = cellMatcher(path);
    setChoices((m) => {
      let changed = false;
      const next = { ...m };
      for (const k of Object.keys(m)) {
        // No fresh print (hunk gone or the content turned binary) is a mismatch
        // too — a choice only survives when its hunk provably matches.
        if (isCell(k) && fresh[k] !== m[k].print) {
          delete next[k];
          changed = true;
        }
      }
      return changed ? next : m;
    });
  }, []);

  useEffect(() => {
    if (!repoPath || !selected || !needsContent || cached) {
      setContentLoading(false);
      return;
    }
    const token = ++fetchTokenRef.current;
    const isCurrent = beginFetch(selected);
    setContentLoading(true);
    readSelectedContent(repoPath, selected, stagedResult)
      .then((content) => {
        if (isCurrent()) applyFresh(selected, content);
        // The loading lifecycle stays on the global token: it tracks "the fetch
        // for the currently relevant selection", not per-path recency.
        if (fetchTokenRef.current !== token) return;
        setContentLoading(false);
      })
      .catch(() => {
        if (fetchTokenRef.current !== token) return;
        setContentLoading(false);
        // Surface the failure instead of leaving the editor silently blank —
        // otherwise the file looks stuck between loading and an empty editor.
        useUi.getState().showToast(`Couldn't load conflicts in ${selected}`, "error");
      });
  }, [repoPath, selected, needsContent, stagedResult, cached, applyFresh, beginFetch]);

  // Drop cached content when a file crosses the resolved boundary either way.
  // Unstage must not reuse the staged result as marker text; a just-staged file
  // must not keep showing the conflicted snapshot it was cached as (Apply /
  // Mark resolved would otherwise paint conflict markers as the "result").
  // Only the *transition* drops — a persistent "drop while resolved" would
  // fight the staged-result fetch (cache, delete, refetch, forever).
  // JSON-encoded like `filePaths`, so a newline in a filename can't split it.
  const resolvedPaths = JSON.stringify(files.filter((f) => f.resolved).map((f) => f.path));
  const wasResolved = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = new Set<string>(JSON.parse(resolvedPaths) as string[]);
    const reconflicted = [...wasResolved.current].filter((p) => !now.has(p));
    const newlyResolved = [...now].filter((p) => !wasResolved.current.has(p));
    wasResolved.current = now;
    const toDrop = [...reconflicted, ...newlyResolved];
    if (toDrop.length === 0) return;
    setCache((c) => {
      const next = { ...c };
      let changed = false;
      for (const p of toDrop) {
        if (p in next) {
          delete next[p];
          changed = true;
        }
      }
      return changed ? next : c;
    });
  }, [resolvedPaths]);

  // A fresh `operation` object means the store re-read the worktree (watcher or
  // a write), so a conflicted file may have changed on disk — e.g. the user
  // resolved it in an external editor. Drop cached marker text for unresolved
  // files other than the open one (they re-fetch on next select), and
  // background-revalidate the open file (no spinner — its content stays visible)
  // so a later in-app stage can't overwrite an external resolution with stale text.
  // The transition is keyed by the operation object alone, but must read the
  // selection/files/cache current at that moment — the latest-value ref carries
  // them in without turning them into effect triggers.
  useEffect(() => {
    if (!repoPath) return;
    const { files, selected, cache } = latestInputs.current;
    const unresolvedText = new Set(
      files.filter((f) => !f.resolved && f.kind === "text").map((f) => f.path),
    );
    setCache((c) => {
      let changed = false;
      const next = { ...c };
      for (const p of Object.keys(next)) {
        if (p !== selected && unresolvedText.has(p)) {
          delete next[p];
          changed = true;
        }
      }
      return changed ? next : c;
    });
    if (selected && unresolvedText.has(selected) && cache[selected]) {
      const isCurrent = beginFetch(selected);
      api
        .conflictFile(repoPath, selected)
        .then((content) => {
          if (isCurrent()) applyFresh(selected, content);
        })
        .catch(() => {
          /* keep the prior content; a hard load failure surfaces via the primary fetch */
        });
    }
  }, [operation, repoPath, applyFresh, beginFetch]);

  const {
    select,
    decide,
    setLineSelection,
    setCustomResolution,
    setFileResolution,
    undo,
    resetFile,
  } = useDecisionEditing({ setSelected, setChoices, setFileText }, latestInputs);

  const revalidate = useCallback(
    async (path: string): Promise<ConflictFileContent | null> => {
      if (!repoPath) return null;
      const isCurrent = beginFetch(path);
      try {
        const content = await api.conflictFile(repoPath, path);
        if (isCurrent()) applyFresh(path, content);
        // Superseded or not, this IS the content this caller read from disk —
        // return it so the caller plans against its own read.
        return content;
      } catch {
        // Keep the prior content and decisions; the caller decides how (and
        // whether) to surface the failed re-read.
        return null;
      }
    },
    [repoPath, applyFresh, beginFetch],
  );

  const contentFor = useCallback((path: string) => cache[path], [cache]);
  const content = selected ? cache[selected] ?? null : null;

  // The facade is memoized so its identity only changes when one of its parts
  // does — consumers can list `resolver` (or destructured members) honestly in
  // their hook dependencies instead of hand-maintaining member lists (GL-178).
  return useMemo(
    () => ({
      mode,
      setMode,
      selected,
      select,
      content,
      contentLoading,
      contentFor,
      choices,
      fileText,
      decide,
      setLineSelection,
      setCustomResolution,
      setFileResolution,
      undo,
      resetFile,
      revalidate,
      confirmAbort,
      setConfirmAbort,
    }),
    [
      mode,
      selected,
      select,
      content,
      contentLoading,
      contentFor,
      choices,
      fileText,
      decide,
      setLineSelection,
      setCustomResolution,
      setFileResolution,
      undo,
      resetFile,
      revalidate,
      confirmAbort,
    ],
  );
}
