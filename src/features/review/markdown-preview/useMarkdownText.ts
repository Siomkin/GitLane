import { useEffect, useState } from "react";
// eslint-disable-next-line no-restricted-imports -- local markdown-preview text probe, the same disposable preview boundary as BinaryDiff's image blob (architecture-rules-react.md §1)
import { api } from "@/lib/api";
import { decodeBase64Text, type PreviewSource } from "./preview";

/** Hard cap on markdown source rendered inline. Rendering a multi-megabyte
 * document would wedge the webview long before it's readable anyway. */
const MAX_PREVIEW_TEXT_BYTES = 2 * 1024 * 1024; // 2 MiB

export interface MarkdownTextState {
  text: string | null;
  loading: boolean;
  /** Content exceeded the preview cap; `size` says how big it is. */
  tooLarge: boolean;
  size: number | null;
  error: boolean;
}

/** Fetch one side's text for the markdown preview. Re-runs only when the
 * underlying source identity (oid/file) changes, not on every parent render. */
export function useMarkdownText(repoPath: string | null, source: PreviewSource | null): MarkdownTextState {
  const [state, setState] = useState<MarkdownTextState>({
    text: null,
    loading: !!(repoPath && source),
    tooLarge: false,
    size: null,
    error: false,
  });
  const oid = source?.oid ?? null;
  const file = source?.file ?? null;

  useEffect(() => {
    if (!repoPath || (!oid && !file)) {
      setState({ text: null, loading: false, tooLarge: false, size: null, error: false });
      return;
    }
    let live = true;
    setState({ text: null, loading: true, tooLarge: false, size: null, error: false });
    api
      .readBinaryBlob(repoPath, { oid, file }, MAX_PREVIEW_TEXT_BYTES)
      .then((blob) => {
        if (!live) return;
        if (blob.base64 != null) {
          setState({ text: decodeBase64Text(blob.base64), loading: false, tooLarge: false, size: blob.size, error: false });
        } else {
          setState({ text: null, loading: false, tooLarge: true, size: blob.size, error: false });
        }
      })
      .catch(() => {
        if (live) setState({ text: null, loading: false, tooLarge: false, size: null, error: true });
      });
    return () => {
      live = false;
    };
  }, [repoPath, oid, file]);

  return state;
}
