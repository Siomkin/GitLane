// The conflict workspace's view model (GL-179): everything the workspace view
// renders, derived from the operation + the resolver facade through the pure
// `conflictWorkspaceModel` functions with clean, validated hook dependencies.
// No store or IPC access here — the container owns store/API wiring.

import { useCallback, useMemo } from "react";
import type { OperationFile, OperationState } from "@/store/repo";
import {
  buildLineEditor,
  effectiveDecision,
  parseConflict,
  type LineEditor,
  type LineSelection,
  type Region,
  type RegionDecision,
} from "@/features/conflicts/conflictModel";
import type { ConflictResolver } from "@/features/conflicts/useConflictResolver";
import {
  fileCells,
  fileResolutionState,
  pickSelection,
  resolvedTextFor,
  sideLabels,
  stageAllEligible,
  takenBlock,
  toggledLine,
  withBlock,
  type EditorSide,
  type FileEdit,
  type FileResolutionState,
  type Resolutions,
} from "./conflictWorkspaceModel";

/** Stable stand-in while no operation is active — `files` feeds memo inputs, so
 * its no-operation fallback must not change identity per render (GL-178). */
const NO_FILES: OperationState["files"] = [];

export interface ConflictWorkspaceModel {
  files: OperationState["files"];
  total: number;
  resolvedCount: number;
  unresolved: number;
  allResolved: boolean;
  selectedFile: OperationFile | null;
  /** The selected path ("" before any selection) — the decision-map key. */
  path: string;
  oursSub: string;
  theirsSub: string;
  regions: Region[];
  decisionFor: (idx: number) => RegionDecision | undefined;
  /** Custom (rewritten) lines a hunk was resolved with, if any. */
  customFor: (idx: number) => string[] | undefined;
  lineSelFor: (idx: number) => LineSelection;
  lineEditor: LineEditor;
  /** The selected file's resolution flags (staging gates, editor chrome). */
  state: FileResolutionState;
  canStageAll: boolean;
  onToggleLine: (idx: number, side: EditorSide, lineIdx: number) => void;
  onSetBlock: (idx: number, side: EditorSide, on: boolean) => void;
  onTakeBlock: (idx: number, which: "a" | "b" | "both") => void;
  onSelectAllSide: (side: EditorSide, on: boolean) => void;
  /** Replace a hunk's output with literal lines (an empty array = keep nothing). */
  onEditOutput: (idx: number, lines: string[]) => void;
  /** The whole-file Output editor, when an agent rewrite could not be mapped
   * onto hunks — null while the file resolves hunk by hunk. */
  fileEdit: FileEdit | null;
  /** Merged text for one file when fully decided, else null (stage-all's
   * render-snapshot pre-filter; the write itself re-plans against fresh
   * content via `stagePlanFor`). */
  resolvedTextFor: (file: OperationFile) => string | null;
}

export function useConflictWorkspaceModel(
  operation: OperationState | null,
  headBranch: string | null,
  resolver: ConflictResolver,
): ConflictWorkspaceModel {
  const files = operation?.files ?? NO_FILES;
  const total = files.length;
  const resolvedCount = files.filter((f) => f.resolved).length;
  const unresolved = total - resolvedCount;
  const allResolved = total === 0 || files.every((f) => f.resolved);

  const selectedFile = files.find((f) => f.path === resolver.selected) ?? null;
  const path = resolver.selected ?? "";
  const { oursSub, theirsSub } = sideLabels(operation?.kind ?? null, headBranch);

  // Parse the selected text file's conflicted content into hunks (the editor is
  // a painter over these). Non-text / unloaded files yield no regions.
  const content = resolver.content;
  const regions = useMemo(() => {
    if (!selectedFile || selectedFile.kind !== "text" || !content) return [];
    if (content.binary) return [];
    return parseConflict(content.content);
  }, [selectedFile, content]);

  // Per-file decision lookups for the selected path, off the stable facade's
  // slices so every memo lists exactly what it reads (GL-178/GL-179).
  const { contentFor, decisions, lineSel, customText, fileText, hunkPrints, resetFile, setLineSelection, setCustomResolution, setFileResolution } =
    resolver;
  // The five per-cell maps travel together into every staging derivation; one
  // memo keeps their combined identity as tight as the parts (GL-178).
  const resolutions = useMemo<Resolutions>(
    () => ({ decisions, lineSel, hunkPrints, customText, fileText }),
    [decisions, lineSel, hunkPrints, customText, fileText],
  );
  const fileDecisions = useMemo(
    () => fileCells(regions, decisions, path),
    [regions, decisions, path],
  );
  const fileLineSel = useMemo(() => fileCells(regions, lineSel, path), [regions, lineSel, path]);
  const fileCustom = useMemo(
    () => fileCells(regions, customText, path),
    [regions, customText, path],
  );
  const customFor = useCallback((idx: number) => fileCustom[idx], [fileCustom]);

  // The effective per-hunk decision reconciles whole-hunk + line-level choices.
  const decisionFor = useCallback(
    (idx: number) => effectiveDecision(fileDecisions[idx], fileLineSel[idx]),
    [fileDecisions, fileLineSel],
  );
  const lineSelFor = useCallback(
    (idx: number) => fileLineSel[idx] ?? new Set<string>(),
    [fileLineSel],
  );
  // For the line editor: explicit picks, else the picks implied by a whole-hunk
  // decision (so switching modes carries the choice over).
  const selectionFor = useCallback(
    (idx: number) => pickSelection(regions, idx, fileDecisions, fileLineSel),
    [regions, fileDecisions, fileLineSel],
  );
  const lineEditor = useMemo(
    () => buildLineEditor(regions, selectionFor, customFor),
    [regions, selectionFor, customFor],
  );

  const fileOverride = fileText[path];
  const fileOverrideOk = !!content && fileOverride?.from === content.content;
  const state = useMemo(
    () =>
      fileResolutionState(
        selectedFile,
        content,
        regions,
        fileDecisions,
        fileLineSel,
        fileOverrideOk,
      ),
    [selectedFile, content, regions, fileDecisions, fileLineSel, fileOverrideOk],
  );

  const canStageAll = useMemo(
    () => stageAllEligible(files, contentFor, resolutions),
    [files, contentFor, resolutions],
  );

  // Line-editor mutations: compute the next selection from the current
  // effective one and hand it to the resolver (which stores it and clears any
  // whole-hunk decision). Plain handlers — recreated per render, used on click.
  const onToggleLine = (idx: number, side: EditorSide, lineIdx: number) =>
    setLineSelection(path, idx, toggledLine(selectionFor(idx), side, lineIdx));
  const onSetBlock = (idx: number, side: EditorSide, on: boolean) => {
    const region = regions[idx];
    if (!region || region.kind !== "cf") return;
    setLineSelection(path, idx, withBlock(selectionFor(idx), region, side, on));
  };
  const onTakeBlock = (idx: number, which: "a" | "b" | "both") => {
    const region = regions[idx];
    if (!region || region.kind !== "cf") return;
    setLineSelection(path, idx, takenBlock(region, which));
  };
  const onSelectAllSide = (side: EditorSide, on: boolean) => {
    regions.forEach((region, idx) => {
      if (region.kind !== "cf") return;
      setLineSelection(path, idx, withBlock(selectionFor(idx), region, side, on));
    });
  };
  const onEditOutput = (idx: number, lines: string[]) => setCustomResolution(path, idx, lines);
  const fileEdit: FileEdit | null = fileOverrideOk
    ? {
        text: fileOverride?.text ?? "",
        onEdit: (text) => {
          if (content) setFileResolution(path, text, content.content);
        },
        onUndo: () => resetFile(path),
      }
    : null;

  return {
    files,
    total,
    resolvedCount,
    unresolved,
    allResolved,
    selectedFile,
    path,
    oursSub,
    theirsSub,
    regions,
    decisionFor,
    customFor,
    lineSelFor,
    lineEditor,
    state,
    canStageAll,
    onToggleLine,
    onSetBlock,
    onTakeBlock,
    onSelectAllSide,
    onEditOutput,
    fileEdit,
    // Kind-gated like stageAllEligible: stale cached text must never stage
    // over a file a refresh reclassified as binary/deleted (GL-179 review).
    resolvedTextFor: (file) =>
      file.kind === "text" ? resolvedTextFor(contentFor(file.path), file.path, resolutions) : null,
  };
}
