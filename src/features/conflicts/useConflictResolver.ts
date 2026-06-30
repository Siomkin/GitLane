import { useCallback, useEffect, useRef, useState } from "react";
// eslint-disable-next-line no-restricted-imports -- feature hook owning the conflict-resolution flow (architecture-rules-react.md §1)
import { api, type ConflictFileContent } from "../../lib/api";
import type { OperationState } from "../../store/repo";
import { useUi } from "../../store/ui";
import type { RegionDecision } from "./conflictModel";

export type EditorMode = "inline" | "split";

/** Composite key for per-hunk state — one file's hunk index. */
const cell = (path: string, idx: number) => `${path}::${idx}`;

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
  /** Per-hunk decisions, keyed by `path::idx`. */
  decisions: Record<string, RegionDecision>;
  /** Per-hunk line picks for the line editor, keyed by `path::idx`. */
  lineSel: Record<string, Set<string>>;
  decide: (path: string, idx: number, decision: RegionDecision) => void;
  /** Replace a hunk's line selection (the line editor's single mutation). An
   * empty set clears the hunk back to undecided; a non-empty set supersedes any
   * whole-hunk decision. */
  setLineSelection: (path: string, idx: number, selection: Set<string>) => void;
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
  const [decisions, setDecisions] = useState<Record<string, RegionDecision>>({});
  const [lineSel, setLineSel] = useState<Record<string, Set<string>>>({});
  const [confirmAbort, setConfirmAbort] = useState(false);
  const [cache, setCache] = useState<Record<string, ConflictFileContent>>({});
  const [contentLoading, setContentLoading] = useState(false);

  const files = operation?.files ?? [];
  const firstUnresolved = files.find((f) => !f.resolved)?.path ?? files[0]?.path ?? null;

  // Default-select the first outstanding conflict, and keep a valid selection as
  // files resolve/leave the set. A still-valid manual selection is preserved.
  useEffect(() => {
    setSelected((prev) =>
      prev && files.some((f) => f.path === prev) ? prev : firstUnresolved,
    );
  }, [firstUnresolved, files]);

  // Fetch the selected text file's conflicted content (cached). Deleted/binary
  // files carry their own card and need no marker content.
  const selectedFile = files.find((f) => f.path === selected) ?? null;
  const needsContent = !!selected && selectedFile?.kind === "text" && !selectedFile.resolved;
  const cached = selected ? cache[selected] : undefined;
  const fetchTokenRef = useRef(0);

  useEffect(() => {
    if (!repoPath || !selected || !needsContent || cached) {
      setContentLoading(false);
      return;
    }
    const token = ++fetchTokenRef.current;
    setContentLoading(true);
    api
      .conflictFile(repoPath, selected)
      .then((content) => {
        if (fetchTokenRef.current !== token) return;
        setCache((c) => ({ ...c, [selected]: content }));
        setContentLoading(false);
      })
      .catch(() => {
        if (fetchTokenRef.current !== token) return;
        setContentLoading(false);
        // Surface the failure instead of leaving the editor silently blank —
        // otherwise the file looks stuck between loading and an empty editor.
        useUi.getState().showToast(`Couldn't load conflicts in ${selected}`, "error");
      });
  }, [repoPath, selected, needsContent, cached]);

  // Drop cached content when a file leaves the conflict set, so re-conflicting it
  // (Unstage) re-fetches fresh marker content rather than reusing a stale copy.
  const resolvedPaths = files
    .filter((f) => f.resolved)
    .map((f) => f.path)
    .join("\n");
  useEffect(() => {
    if (!resolvedPaths) return;
    const gone = new Set(resolvedPaths.split("\n"));
    setCache((c) => {
      const next = { ...c };
      let changed = false;
      for (const p of Object.keys(next)) {
        if (gone.has(p)) {
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
  useEffect(() => {
    if (!repoPath) return;
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
      const token = ++fetchTokenRef.current;
      api
        .conflictFile(repoPath, selected)
        .then((content) => {
          if (fetchTokenRef.current !== token) return;
          setCache((c) => ({ ...c, [selected]: content }));
        })
        .catch(() => {
          /* keep the prior content; a hard load failure surfaces via the primary fetch */
        });
    }
    // Re-run only when a new operation status arrives (a worktree refresh),
    // reading the latest selected/files/cache at that point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operation, repoPath]);

  const select = useCallback((path: string) => setSelected(path), []);

  const decide = useCallback((path: string, idx: number, decision: RegionDecision) => {
    const key = cell(path, idx);
    setDecisions((d) => ({ ...d, [key]: decision }));
    // A whole-hunk choice supersedes any prior line-level picks.
    setLineSel((s) => {
      if (!s[key]) return s;
      const next = { ...s };
      delete next[key];
      return next;
    });
  }, []);

  const setLineSelection = useCallback((path: string, idx: number, selection: Set<string>) => {
    const key = cell(path, idx);
    setLineSel((s) => {
      const next = { ...s };
      if (selection.size === 0) delete next[key];
      else next[key] = selection;
      return next;
    });
    // A line selection is its own decision mode; drop any whole-hunk choice so
    // the effective decision derives from the picks (or clears when empty).
    setDecisions((d) => {
      if (!d[key]) return d;
      const next = { ...d };
      delete next[key];
      return next;
    });
  }, []);

  const undo = useCallback((path: string, idx: number) => {
    const key = cell(path, idx);
    setDecisions((d) => {
      const next = { ...d };
      delete next[key];
      return next;
    });
    setLineSel((s) => {
      if (!s[key]) return s;
      const next = { ...s };
      delete next[key];
      return next;
    });
  }, []);

  const resetFile = useCallback((path: string) => {
    const prefix = `${path}::`;
    const drop = (obj: Record<string, unknown>) => {
      const next = { ...obj };
      let changed = false;
      for (const k of Object.keys(next)) {
        if (k.startsWith(prefix)) {
          delete next[k];
          changed = true;
        }
      }
      return { next, changed };
    };
    setDecisions((d) => {
      const { next, changed } = drop(d);
      return changed ? (next as Record<string, RegionDecision>) : d;
    });
    setLineSel((s) => {
      const { next, changed } = drop(s);
      return changed ? (next as Record<string, Set<string>>) : s;
    });
  }, []);

  const contentFor = useCallback((path: string) => cache[path], [cache]);

  return {
    mode,
    setMode,
    selected,
    select,
    content: selected ? cache[selected] ?? null : null,
    contentLoading,
    contentFor,
    decisions,
    lineSel,
    decide,
    setLineSelection,
    undo,
    resetFile,
    confirmAbort,
    setConfirmAbort,
  };
}
