// Shared representation of a binary (non-text) file change across every diff
// surface — review, stacked review, commit-modal preview, and history/compare.
// Replaces the bare "Binary file" placeholder with a type + change-kind + size
// card, and an inline image preview (added → new; deleted → old; modified →
// before/after) for previewable image types. Read-only: no editing of bytes.

import { useEffect, useState } from "react";
import type { BinaryFileKind } from "../../lib/binaryFile";
import { binaryFileKind, changeVerb, formatBytes, formatDelta } from "../../lib/binaryFile";
import { api, type FileDiff } from "../../lib/api";
import { cn } from "../../lib/cn";
import { useRepo } from "../../store/repo";
import { FileIcon } from "@/components/ui/icons";

/** Which blob a preview reads: a committed/staged blob (`oid`) or, when the diff
 * left no oid, the working-tree file (`file`, repo-relative). */
type BlobSource = { oid?: string | null; file?: string | null };

export const BinaryDiff = ({ diff, className }: { diff: FileDiff; className?: string }) => {
  const repoPath = useRepo((s) => s.summary?.path ?? null);
  const kind = binaryFileKind(diff.path);
  const sources = imageSources(diff);
  const showImages = kind.isImage && repoPath && (sources.before || sources.after);

  return (
    <div className={cn("flex flex-col items-center justify-center gap-5 p-6", className)}>
      <BinaryCard diff={diff} kind={kind} />
      {showImages && repoPath ? (
        <ImageComparison repoPath={repoPath} mime={kind.mime} sources={sources} />
      ) : null}
    </div>
  );
};

/** The type + change-kind + size summary card, shown for every binary change. */
const BinaryCard = ({ diff, kind }: { diff: FileDiff; kind: BinaryFileKind }) => {
  const verb = changeVerb(diff.status);
  return (
    <div className="flex w-full max-w-md items-center gap-3 rounded-xl border border-black/10 bg-black/[0.02] px-4 py-3 dark:border-white/10 dark:bg-white/[0.03]">
      <span className="text-neutral-500 dark:text-neutral-400">
        <FileIcon path={diff.path} size={28} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-[color:var(--accent)]/10 px-1.5 py-0.5 text-[11px] font-semibold text-[color:var(--accent)]">
            {verb}
          </span>
          <span className="truncate text-[13px] font-medium text-neutral-700 dark:text-neutral-200">
            {kind.label}
          </span>
        </div>
        <div className="mt-1 font-mono text-[12px] text-neutral-500 dark:text-neutral-400">
          <SizeSummary diff={diff} />
        </div>
      </div>
    </div>
  );
};

/** "old → new (±delta)" for a modified binary; a single size for add/delete; a
 * plain "Binary file" when no size is known (e.g. a GitHub PR patch). */
const SizeSummary = ({ diff }: { diff: FileDiff }) => {
  const { oldSize, newSize } = diff;
  if (oldSize != null && newSize != null) {
    return (
      <span>
        {formatBytes(oldSize)} <span className="opacity-60">→</span> {formatBytes(newSize)}
        <span className="ml-1.5 opacity-70">({formatDelta(oldSize, newSize)})</span>
      </span>
    );
  }
  if (newSize != null) return <span>{formatBytes(newSize)}</span>;
  if (oldSize != null) return <span>{formatBytes(oldSize)}</span>;
  return <span>Binary file — no text diff.</span>;
};

/** The two blob sources for an image diff. `before` is read only via an oid (we
 * can't reconstruct the old worktree file); `after` falls back to the
 * working-tree file when the diff left no new-side oid (the unstaged case). */
const imageSources = (diff: FileDiff): { before: BlobSource | null; after: BlobSource | null } => {
  const before = diff.oldOid ? { oid: diff.oldOid } : null;
  const after = diff.newOid
    ? { oid: diff.newOid }
    : diff.newSize != null
      ? { file: diff.path }
      : null;
  return { before, after };
};

const ImageComparison = ({
  repoPath,
  mime,
  sources,
}: {
  repoPath: string;
  mime: string;
  sources: { before: BlobSource | null; after: BlobSource | null };
}) => {
  const both = sources.before && sources.after;
  return (
    <div
      className={cn(
        "grid w-full max-w-3xl gap-4",
        both ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1",
      )}
    >
      {sources.before ? (
        <ImagePane repoPath={repoPath} mime={mime} source={sources.before} label={both ? "Before" : "Removed"} />
      ) : null}
      {sources.after ? (
        <ImagePane repoPath={repoPath} mime={mime} source={sources.after} label={both ? "After" : "Preview"} />
      ) : null}
    </div>
  );
};

// Checkerboard so transparent images (icons, PNGs with alpha) read clearly.
const CHECKER =
  "repeating-conic-gradient(rgba(128,128,128,0.16) 0% 25%, transparent 0% 50%) 50% / 16px 16px";

const ImagePane = ({
  repoPath,
  mime,
  source,
  label,
}: {
  repoPath: string;
  mime: string;
  source: BlobSource;
  label: string;
}) => {
  const state = useImageBlob(repoPath, mime, source);
  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      <figcaption className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
        {label}
      </figcaption>
      <div
        className="grid min-h-[88px] place-items-center overflow-hidden rounded-lg border border-black/10 p-2 dark:border-white/10"
        style={{ background: CHECKER }}
      >
        {state.loading ? (
          <span className="text-[12px] text-neutral-400">Loading preview…</span>
        ) : state.url ? (
          <img
            src={state.url}
            alt={label}
            className="max-h-[320px] max-w-full object-contain"
          />
        ) : state.tooLarge ? (
          <span className="px-2 text-center text-[12px] text-neutral-400">
            {formatBytes(state.size ?? 0)} — too large to preview
          </span>
        ) : (
          <span className="text-[12px] text-neutral-400">Couldn't load preview.</span>
        )}
      </div>
    </figure>
  );
};

interface ImageState {
  url: string | null;
  loading: boolean;
  tooLarge: boolean;
  size: number | null;
}

/** Fetch one image blob and build a data URL. Re-runs only when the underlying
 * source identity (oid/file) changes, not on every parent render. */
const useImageBlob = (repoPath: string, mime: string, source: BlobSource): ImageState => {
  const [state, setState] = useState<ImageState>({
    url: null,
    loading: true,
    tooLarge: false,
    size: null,
  });
  const oid = source.oid ?? null;
  const file = source.file ?? null;

  useEffect(() => {
    let live = true;
    setState({ url: null, loading: true, tooLarge: false, size: null });
    api
      .readBinaryBlob(repoPath, { oid, file })
      .then((blob) => {
        if (!live) return;
        if (blob.base64) {
          setState({ url: `data:${mime};base64,${blob.base64}`, loading: false, tooLarge: false, size: blob.size });
        } else {
          setState({ url: null, loading: false, tooLarge: true, size: blob.size });
        }
      })
      .catch(() => {
        if (live) setState({ url: null, loading: false, tooLarge: false, size: null });
      });
    return () => {
      live = false;
    };
  }, [repoPath, mime, oid, file]);

  return state;
};
