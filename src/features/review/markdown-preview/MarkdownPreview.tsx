// Rendered-markdown Preview mode for the review surface: shows the NEW side of
// the selected .md file (worktree / index / commit blob) through the same
// sanitized GFM renderer as PR descriptions, instead of the raw diff.

import type { FileDiff } from "../../../lib/api";
import type { ChangeSource } from "../../../store/repoTypes";
import { useRepo } from "../../../store/repo";
import { Markdown } from "@/components/ui/Markdown";
import { formatBytes } from "../../../lib/binaryFile";
import { previewSource } from "./preview";
import { useMarkdownText } from "./useMarkdownText";

export function MarkdownPreview({ diff, source }: { diff: FileDiff; source: ChangeSource }) {
  const repoPath = useRepo((s) => s.summary?.path ?? null);
  const blobSource = previewSource(diff, source);
  const state = useMarkdownText(repoPath, blobSource);

  if (!blobSource) {
    return (
      <PreviewNotice>
        {diff.status === "D" ? "This file was deleted — nothing to preview." : "No content to preview."}
      </PreviewNotice>
    );
  }
  if (state.loading) return <PreviewNotice>Loading preview…</PreviewNotice>;
  if (state.tooLarge) {
    return <PreviewNotice>{formatBytes(state.size ?? 0)} — too large to preview.</PreviewNotice>;
  }
  if (state.error || state.text == null) return <PreviewNotice>Couldn't load preview.</PreviewNotice>;
  // Guard before <Markdown>, whose empty state says "No description." (it was
  // written for PR bodies).
  if (!state.text.trim()) return <PreviewNotice>Empty file.</PreviewNotice>;

  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="markdown-preview">
      <div className="mx-auto w-full max-w-[780px] px-6 py-5">
        <Markdown content={state.text} />
      </div>
    </div>
  );
}

function PreviewNotice({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-0 flex-1 place-content-center text-sm text-neutral-400">{children}</div>;
}
