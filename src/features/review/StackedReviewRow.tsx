import { AgentChangeDescription } from "@/features/changes/AgentChangeDescription";
import { BinaryDiff } from "./BinaryDiff";
import { DiffTruncatedNotice, HunkCardHeader, UnifiedLine } from "./DiffBody";
import type { LineCommentsController } from "./comments";
import { StackedFileHeader } from "./StackedFileHeader";
import type { StackedReviewRow as Row } from "./stackedReviewRows";

export function StackedReviewRow({
  row,
  surface,
  descriptionInstruction,
  selectedPath,
  controllerFor,
  onToggle,
  onShowFull,
}: {
  row: Row;
  surface: string;
  descriptionInstruction: string;
  selectedPath: string | null;
  controllerFor: (file: string) => LineCommentsController;
  onToggle: (path: string) => void;
  onShowFull: (path: string) => void;
}) {
  switch (row.kind) {
    case "description":
      return (
        <AgentChangeDescription
          contextKey={surface}
          instruction={descriptionInstruction}
        />
      );
    case "file-header":
      return (
        <StackedFileHeader
          file={row.file}
          open={row.open}
          active={selectedPath === row.file.path}
          onToggle={() => onToggle(row.file.path)}
        />
      );
    case "hunk":
      return <HunkCardHeader header={row.row.header} changed={row.row.changed} />;
    case "line": {
      const controller = controllerFor(row.file.path);
      return (
        <UnifiedLine
          line={row.row.line}
          comments={controller.rowFor(row.row.seq)}
          controller={controller}
        />
      );
    }
    case "binary":
      return <BinaryDiff diff={row.diff} />;
    case "truncated":
      return <DiffTruncatedNotice onShowFull={() => onShowFull(row.file.path)} />;
    case "loading":
      return <RowMessage>Loading diff…</RowMessage>;
    case "placeholder":
      return (
        <div style={{ height: row.size }}>
          <RowMessage>Loading diff…</RowMessage>
        </div>
      );
    case "message":
      return <RowMessage>{row.message}</RowMessage>;
  }
}

function RowMessage({ children }: { children: string }) {
  return (
    <div className="border-b border-black/5 bg-white px-4 py-3 text-xs text-neutral-400 dark:border-white/5 dark:bg-neutral-800">
      {children}
    </div>
  );
}
