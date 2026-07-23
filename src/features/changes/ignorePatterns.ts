/** Pure helpers for the Ignore… submenu on uncommitted file rows (ADR 0002). */

import { basename } from "@/lib/paths";

/** One concrete pattern the menu can append without prompting. */
export interface IgnorePatternChoice {
  /** Menuitem label (without trailing ellipsis). */
  label: string;
  /** Exact gitignore line to append. */
  pattern: string;
  /** When true, write to `.git/info/exclude` instead of root `.gitignore`. */
  local: boolean;
}

/** Extension for `*.ext` ignore, or null when the name has no useful extension
 * (e.g. `.env`, `.gitignore`, `Makefile`). */
export function ignoreExtension(fileName: string): string | null {
  if (fileName.startsWith(".") && !fileName.slice(1).includes(".")) return null;
  const i = fileName.lastIndexOf(".");
  if (i <= 0 || i === fileName.length - 1) return null;
  return fileName.slice(i + 1);
}

/** Escape gitignore glob metacharacters in a literal path segment so a name like
 * `draft[1].txt` is matched literally instead of as a character class. Path
 * separators (`/`) are intentionally left intact. */
export function escapeIgnoreLiteral(text: string): string {
  return text.replace(/[\\*?[\]]/g, "\\$&");
}

/** Anchor a repo-relative path for root `.gitignore` (`/path/to/file`). */
export function anchoredIgnorePath(path: string): string {
  const trimmed = path.replace(/^\/+/, "").replace(/\/+$/, "");
  return `/${escapeIgnoreLiteral(trimmed)}`;
}

/** Parent directory pattern for a file path, or null at repo root. */
export function parentFolderIgnorePattern(path: string): string | null {
  const trimmed = path.replace(/^\/+/, "").replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  if (slash <= 0) return null;
  return anchoredIgnorePath(trimmed.slice(0, slash)) + "/";
}

/** Build the fixed Ignore… choices for a file or directory path. Custom pattern
 * is a separate prompt and is not included here. */
export function ignorePatternChoices(
  path: string,
  opts?: { dir?: boolean },
): IgnorePatternChoice[] {
  const name = basename(path);
  const choices: IgnorePatternChoice[] = [];

  if (opts?.dir) {
    const folder = anchoredIgnorePath(path) + "/";
    choices.push({
      label: `Ignore folder “${name}/”`,
      pattern: folder,
      local: false,
    });
    choices.push({
      label: "Ignore folder locally (exclude)",
      pattern: folder,
      local: true,
    });
    return choices;
  }

  const anchored = anchoredIgnorePath(path);
  choices.push({
    label: `Ignore “${name}”`,
    pattern: anchored,
    local: false,
  });

  const ext = ignoreExtension(name);
  if (ext) {
    choices.push({
      label: `Ignore all *.${ext}`,
      pattern: `*.${escapeIgnoreLiteral(ext)}`,
      local: false,
    });
  }

  const folder = parentFolderIgnorePattern(path);
  if (folder) {
    const folderName = basename(folder.replace(/\/$/, ""));
    choices.push({
      label: `Ignore folder “${folderName}/”`,
      pattern: folder,
      local: false,
    });
  }

  choices.push({
    label: "Ignore locally (exclude)",
    pattern: anchored,
    local: true,
  });

  return choices;
}
