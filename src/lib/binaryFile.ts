// Pure helpers for representing binary file changes in the diff surface: human
// byte sizes, signed deltas, and type categorization (extension → label + image
// MIME). No React, no IPC — imported by BinaryDiff and the file-list rows.

import type { FileStatus } from "./api";

/** Format a byte count as a short human string (e.g. `1.2 KB`, `3.4 MB`). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal under 10 (1.2 KB), none above (340 KB) — compact but readable.
  const text = value >= 10 ? Math.round(value).toString() : value.toFixed(1);
  return `${text} ${units[unit]}`;
}

/** A signed, human-formatted size delta (e.g. `+1.2 KB`, `−340 B`, `±0 B`). */
export function formatDelta(oldBytes: number, newBytes: number): string {
  const diff = newBytes - oldBytes;
  if (diff === 0) return "±0 B";
  const sign = diff > 0 ? "+" : "−";
  return `${sign}${formatBytes(Math.abs(diff))}`;
}

/** Image extensions we can render inline, mapped to their data-URL MIME type. */
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  // SVG is usually text (so it gets a normal diff), but render it as an image
  // if a delta ever comes through flagged binary.
  svg: "image/svg+xml",
};

/** Friendly labels for common non-image binaries, keyed by extension. */
const TYPE_LABEL: Record<string, string> = {
  pdf: "PDF document",
  doc: "Word document",
  docx: "Word document",
  xls: "Spreadsheet",
  xlsx: "Spreadsheet",
  ppt: "Presentation",
  pptx: "Presentation",
  zip: "Archive",
  tar: "Archive",
  gz: "Archive",
  tgz: "Archive",
  rar: "Archive",
  "7z": "Archive",
  mp3: "Audio",
  wav: "Audio",
  mp4: "Video",
  mov: "Video",
  webm: "Video",
  ttf: "Font",
  otf: "Font",
  woff: "Font",
  woff2: "Font",
};

export interface BinaryFileKind {
  /** Lowercase file extension without the dot ("png"), or "" when none. */
  ext: string;
  /** Human label for the file type ("PNG image", "PDF document", "Binary file"). */
  label: string;
  /** True when the type can be previewed inline as an image. */
  isImage: boolean;
  /** Data-URL MIME type for an image preview; "" for non-images. */
  mime: string;
}

/** Classify a path by extension for the binary-diff affordance. */
export function binaryFileKind(path: string): BinaryFileKind {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";

  const mime = IMAGE_MIME[ext];
  if (mime) {
    return { ext, label: `${ext.toUpperCase()} image`, isImage: true, mime };
  }
  if (TYPE_LABEL[ext]) {
    return { ext, label: TYPE_LABEL[ext], isImage: false, mime: "" };
  }
  return {
    ext,
    label: ext ? `${ext.toUpperCase()} file` : "Binary file",
    isImage: false,
    mime: "",
  };
}

/** Past-tense verb for a one-letter git status, used in the binary card
 * ("Added", "Modified", …). Falls back to "Changed". */
export function changeVerb(status: FileStatus | string): string {
  switch (status) {
    case "A":
    case "U":
      return "Added";
    case "D":
      return "Deleted";
    case "R":
      return "Renamed";
    case "C":
      return "Copied";
    case "T":
      return "Type changed";
    default:
      return "Modified";
  }
}
