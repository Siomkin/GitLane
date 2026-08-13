import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// eslint-disable-next-line no-restricted-imports -- feature hook owning the conflict-resolution flow (architecture-rules-react.md §1)
import { api, type ConflictFileContent } from "@/lib/api";
import type { OperationState } from "@/store/repo";
import { useUi } from "@/store/ui";
import { hunkFingerprint, parseConflict, type RegionDecision } from "./conflictModel";

export type EditorMode = "inline" | "split";

/** Composite key for per-hunk state — one file's hunk index. */
const cell = (path: string, idx: number) => `${path}::${idx}`;

/** Immutable "delete this key" updater. Returns the same map when the key is
 * absent, so a no-op never re-renders. */
const without =
  <T,>(key: string) =>
  (m: Record<string, T>): Record<string, T> => {
    if (!(key in m)) return m;
    const next = { ...m };
    delete next[key];
    return next;
  };

/** Key-matcher for one file's cells. A key belongs to `path` only when
 * everything after the prefix is a hunk index — a bare prefix match would also
 * hit a file literally named "<path>::something" (GL-178 review). */
const cellMatcher = (path: string) => {
  const prefix = `${path}::`;
  return (k: string) => k.startsWith(prefix) && /^\d+$/.test(k.slice(prefix.length));
};

/** Per-cell fingerprints of a file's conflict hunks (none for binary content). */
function printsOf(path: string, content: ConflictFileContent): Record<string, string> {
  const out: Record<string, string> = {};
  if (content.binary) return out;
  parseConflict(content.content).forEach((region, idx) => {
    if (region.kind === "cf") out[cell(path, idx)] = hunkFingerprint(region);
  });
  return out;
}

/** Fingerprint of the hunk at one region index, when it is a conflict hunk. */
function printAt(content: ConflictFileContent | undefined, idx: number): string | undefined {
  if (!content || content.binary) return undefined;
  const region = parseConflict(content.content)[idx];
  return region?.kind === "cf" ? hunkFingerprint(region) : undefined;
}

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
  /** Per-hunk decisions, keyed by `path::idx`. */
  decisions: Record<string, RegionDecision>;
  /** Per-hunk line picks for the line editor, keyed by `path::idx`. */
  lineSel: Record<string, Set<string>>;
  /** Per-hunk custom resolution text (lines that exist in neither side — an
   * agent rewrite), keyed like `decisions`; the hunk's decision is "custom". */
  customText: Record<string, string[]>;
  /** Fingerprint of the hunk each decision/pick was made against, keyed like
   * `decisions` (GL-180). Fresh content invalidates only mismatching cells
   * here; stage-time validation re-checks them against the disk copy so a
   * decision can never apply to a hunk that changed under it. */
  hunkPrints: Record<string, string>;
  /** Re-fetch one file's conflicted content from disk, refresh the cache, and
   * invalidate decisions whose hunk changed (GL-180). Returns the fresh
   * content, or null when there is no repo / the read fails (prior content and
   * decisions are kept). Staging paths call this immediately before writing. */
  revalidate: (path: string) => Promise<ConflictFileContent | null>;
  decide: (path: string, idx: number, decision: RegionDecision) => void;
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
  const [decisions, setDecisions] = useState<Record<string, RegionDecision>>({});
  const [lineSel, setLineSel] = useState<Record<string, Set<string>>>({});
  const [hunkPrints, setHunkPrints] = useState<Record<string, string>>({});
  const [customText, setCustomText] = useState<Record<string, string[]>>({});
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
  const latestInputs = useRef({ files, selected, cache, decisions, lineSel, hunkPrints });
  useEffect(() => {
    latestInputs.current = { files, selected, cache, decisions, lineSel, hunkPrints };
  });

  // Store freshly-fetched content and invalidate the decisions/picks whose hunk
  // no longer matches the fingerprint it was decided against (GL-180) — an
  // external edit to one hunk must not leave a decision silently applying to
  // different lines, while untouched hunks keep their decisions (a watcher
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
    const { decisions, lineSel, hunkPrints } = latestInputs.current;
    const fresh = printsOf(path, content);
    const isCell = cellMatcher(path);
    const stale = new Set(
      [...Object.keys(decisions), ...Object.keys(lineSel), ...Object.keys(hunkPrints)].filter(
        // No recorded print (decided against content we no longer have) is
        // stale too — a decision only survives when its hunk provably matches.
        (k) => isCell(k) && (hunkPrints[k] === undefined || hunkPrints[k] !== fresh[k]),
      ),
    );
    if (stale.size === 0) return;
    const dropStale = <T,>(m: Record<string, T>): Record<string, T> => {
      let changed = false;
      const next = { ...m };
      for (const k of stale) {
        if (k in next) {
          delete next[k];
          changed = true;
        }
      }
      return changed ? next : m;
    };
    setDecisions(dropStale);
    setLineSel(dropStale);
    setCustomText(dropStale);
    setHunkPrints(dropStale);
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

  const select = useCallback((path: string) => setSelected(path), []);

  // Record (or clear) the fingerprint of the hunk a cell's choice was made
  // against, from the content cached at that moment — the print is what later
  // invalidates the choice if the hunk changes on disk (GL-180).
  const dropFileText = useCallback((path: string) => setFileText(without(path)), []);

  const setPrint = useCallback((key: string, print: string | undefined) => {
    setHunkPrints((p) => {
      if (print) return p[key] === print ? p : { ...p, [key]: print };
      return without<string>(key)(p);
    });
  }, []);

  const decide = useCallback(
    (path: string, idx: number, decision: RegionDecision) => {
      const key = cell(path, idx);
      setDecisions((d) => ({ ...d, [key]: decision }));
      setPrint(key, printAt(latestInputs.current.cache[path], idx));
      // A whole-hunk choice supersedes any prior line-level picks or rewrite.
      setLineSel(without(key));
      setCustomText(without(key));
      dropFileText(path);
    },
    [dropFileText, setPrint],
  );

  const setLineSelection = useCallback(
    (path: string, idx: number, selection: Set<string>) => {
      const key = cell(path, idx);
      setLineSel((s) => {
        const next = { ...s };
        if (selection.size === 0) delete next[key];
        else next[key] = selection;
        return next;
      });
      // An emptied selection clears the hunk back to undecided — no print left.
      setPrint(
        key,
        selection.size > 0 ? printAt(latestInputs.current.cache[path], idx) : undefined,
      );
      // Ticking lines replaces a custom resolution outright.
      setCustomText(without(key));
      // A line selection is its own decision mode; drop any whole-hunk choice so
      // the effective decision derives from the picks (or clears when empty).
      setDecisions(without(key));
      dropFileText(path);
    },
    [dropFileText, setPrint],
  );

  // A custom resolution is its own decision mode: the literal lines live in
  // `customText`, the hunk's decision becomes "custom", and any prior picks go
  // (they would otherwise win in `effectiveDecision`).
  const setCustomResolution = useCallback(
    (path: string, idx: number, lines: string[]) => {
      const key = cell(path, idx);
      setCustomText((c) => ({ ...c, [key]: lines }));
      setDecisions((d) => ({ ...d, [key]: "custom" }));
      setPrint(key, printAt(latestInputs.current.cache[path], idx));
      setLineSel(without(key));
      dropFileText(path);
    },
    [dropFileText, setPrint],
  );

  const setFileResolution = useCallback((path: string, text: string, from: string) => {
    // A whole-file rewrite replaces every per-hunk choice for this path.
    const isCell = cellMatcher(path);
    const drop = <T,>(m: Record<string, T>): Record<string, T> => {
      const next = { ...m };
      let changed = false;
      for (const k of Object.keys(next)) {
        if (isCell(k)) {
          delete next[k];
          changed = true;
        }
      }
      return changed ? next : m;
    };
    setDecisions(drop);
    setLineSel(drop);
    setCustomText(drop);
    setHunkPrints(drop);
    setFileText((f) => ({ ...f, [path]: { text, from } }));
  }, []);

  const undo = useCallback((path: string, idx: number) => {
    // Each setter infers its own value type, so the key is bound four times
    // rather than sharing one erased updater.
    const key = cell(path, idx);
    setDecisions(without(key));
    setLineSel(without(key));
    setCustomText(without(key));
    setHunkPrints(without(key));
    dropFileText(path);
  }, [dropFileText]);

  const resetFile = useCallback((path: string) => {
    const isCell = cellMatcher(path);
    const drop = <T,>(m: Record<string, T>): Record<string, T> => {
      const next = { ...m };
      let changed = false;
      for (const k of Object.keys(next)) {
        if (isCell(k)) {
          delete next[k];
          changed = true;
        }
      }
      return changed ? next : m;
    };
    setDecisions(drop);
    setLineSel(drop);
    setCustomText(drop);
    setHunkPrints(drop);
    dropFileText(path);
  }, [dropFileText]);

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
      decisions,
      lineSel,
      customText,
      fileText,
      hunkPrints,
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
      decisions,
      lineSel,
      customText,
      fileText,
      hunkPrints,
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
