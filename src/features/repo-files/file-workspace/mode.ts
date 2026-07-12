import { Language, languageForPath } from "../../../lib/highlight";

/** The viewer's Source/Preview switch (GL-212). Compare against
 * `FileViewMode.Preview`, never a bare `"preview"` literal (the RefKind idiom). */
export const FileViewMode = {
  /** Raw / syntax-highlighted text — the GL-211 view. */
  Source: "source",
  /** Rendered output (rendered Markdown today; extensible to other types). */
  Preview: "preview",
} as const;
export type FileViewMode = (typeof FileViewMode)[keyof typeof FileViewMode];

/** Whether a file has a rendered Preview form (only then does the switcher show
 * the Preview segment). Markdown today; the one place to extend for future
 * previewable types (images/SVG). */
export function hasPreview(path: string): boolean {
  return languageForPath(path) === Language.Markdown;
}
