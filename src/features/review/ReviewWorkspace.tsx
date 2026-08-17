import { useState } from "react";
import type { DiffLine } from "@/lib/api";
import { fileWriteGuard } from "@/lib/advancedRepoState";
import { isMarkdownPath } from "@/lib/paths";
import { useRepo } from "@/store/repo";
import { BinaryDiff } from "./BinaryDiff";
import { MarkdownPreview } from "./markdown-preview";
import { HandToAgentBar } from "./comments";
import { reviewSurface } from "./reviewSurface";
import { type HunkActionApi } from "./hunkActions";
import { emptyDiffNotice } from "./diffRows";
import { EmptyDiff } from "./EmptyDiff";
import { ReviewHeader, type DiffMode, type MdView } from "./ReviewHeader";
import { SplitDiff } from "./SplitDiff";
import { UnifiedDiff } from "./UnifiedDiff";

export function ReviewWorkspace({ onBack }: { onBack?: () => void }) {
  const fileDiff = useRepo((state) => state.fileDiff);
  const diffLoading = useRepo((state) => state.diffLoading);
  const selectedFile = useRepo((state) => state.selectedFile);
  const applyHunk = useRepo((state) => state.applyHunk);
  const applyLine = useRepo((state) => state.applyLine);
  const clearSelectedFile = useRepo((state) => state.clearSelectedFile);
  const selectedCommit = useRepo((state) => state.selectedCommit);
  const selectionDiff = useRepo((state) => state.selectionDiff);
  const changes = useRepo((state) => state.changes);
  const [mode, setMode] = useState<DiffMode>("unified");
  // Sticky across file switches (like `mode`): browsing several .md files keeps
  // the chosen view; non-markdown files simply ignore it.
  const [mdView, setMdView] = useState<MdView>("code");
  const markdown = !!fileDiff && !fileDiff.binary && isMarkdownPath(fileDiff.path);
  // Notes are scoped to the diff surface — and, for the working tree, to the
  // staged vs unstaged source — so a comment never reattaches to the same file
  // viewed in a different diff. A committed file shown as part of a multi-commit
  // selection scopes to the whole selection (matching StackedReview), not the
  // focus commit, since the diff is the union — not that one commit's.
  const surface = reviewSurface(
    selectedFile,
    selectedCommit,
    selectionDiff?.commits ?? null,
    selectionDiff?.workingBase ?? null,
  );
  // A rename/copy patch cannot be split: staging one hunk of it would stage the
  // new path alone and strand the old path's deletion — offer whole-file staging
  // only. (The backend now pairs such a diff against the old blob rather than
  // reporting it as an added patch, so what is rendered is the rename itself.)
  const changeFile =
    selectedFile && selectedFile.source !== "commit"
      ? changes[selectedFile.source].find((f) => f.path === selectedFile.path)
      : undefined;
  const wholeFileOnly = changeFile?.status === "R" || changeFile?.status === "C";
  const writeGuard = fileWriteGuard(changeFile, changes);
  const hunkAction: HunkActionApi | null =
    selectedFile && selectedFile.source !== "commit" && !wholeFileOnly && !writeGuard
      ? {
          source: selectedFile.source,
          onApply: (hunkIndex: number, expectedHeader: string, expectedBody: string) =>
            applyHunk(
              selectedFile.path,
              selectedFile.source === "staged",
              hunkIndex,
              expectedHeader,
              expectedBody,
            ),
          onApplyLine: (hunkIndex: number, lineIndex: number, line: DiffLine) =>
            applyLine(selectedFile.path, selectedFile.source === "staged", hunkIndex, lineIndex, line),
        }
      : null;

  return (
    <main className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-black/5 dark:border-white/5 bg-white dark:bg-neutral-800 shadow-sm">
      <ReviewHeader
        file={fileDiff}
        mode={mode}
        onModeChange={setMode}
        markdown={markdown}
        mdView={mdView}
        onMdViewChange={setMdView}
        onBack={onBack ?? clearSelectedFile}
      />

      {diffLoading ? (
        <EmptyDiff title="Loading diff" />
      ) : !fileDiff ? (
        <EmptyDiff title="Select a file to view its diff" />
      ) : fileDiff.binary ? (
        <BinaryDiff diff={fileDiff} className="min-h-0 flex-1 overflow-auto" />
      ) : markdown && mdView === "preview" ? (
        <MarkdownPreview diff={fileDiff} source={selectedFile?.source ?? "commit"} />
      ) : fileDiff.hunks.length === 0 ? (
        <EmptyDiff title={emptyDiffNotice(fileDiff.status)} />
      ) : mode === "split" ? (
        <SplitDiff file={fileDiff} hunkAction={hunkAction} surface={surface} />
      ) : (
        <UnifiedDiff file={fileDiff} hunkAction={hunkAction} surface={surface} />
      )}

      <HandToAgentBar surfaces={[surface]} />
    </main>
  );
}
