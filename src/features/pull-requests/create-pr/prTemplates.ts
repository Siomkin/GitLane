// Pure pull-request-template discovery, plus the "from commits" description.
// No React, no IPC — the caller supplies the repo's file list and reads the
// chosen file.

import type { HistorySearchResult } from "@/lib/api";

export interface PrTemplateRef {
  /** Repo-relative path, passed straight back to the file read. */
  path: string;
  /** Basename, shown on the chip. */
  file: string;
  /** Where it came from, e.g. ".github/" or "PULL_REQUEST_TEMPLATE/". */
  note: string;
}

/** Directories a forge looks in. Most specific first: every path starts with
 * the repository root's empty prefix, so testing it first would claim
 * `.github/…` before the real directory ever matched. */
const TEMPLATE_DIRS = [".github/", "docs/", ""];
/** Basename of the single repository-default template (extension optional). */
const DEFAULT_STEM = "pull_request_template";
/** Directory holding the multiple-template set. */
const MULTI_DIR = "pull_request_template/";
/** Extensions a forge honours: `.md`, `.txt`, or none. */
const TEMPLATE_EXTENSIONS = ["", ".md", ".txt"];

/**
 * Template files present in the repository.
 *
 * Matching is case-insensitive because GitHub accepts every casing
 * (`PULL_REQUEST_TEMPLATE.md`, `pull_request_template.md`, …) and repositories
 * genuinely differ. The repository default sorts first; the multi-template
 * directory follows in path order.
 *
 * `files` is the repo's tracked file list — an untracked template is not
 * offered, matching what the forge itself would use.
 */
export function findPrTemplates(files: string[]): PrTemplateRef[] {
  const defaults: PrTemplateRef[] = [];
  const multi: PrTemplateRef[] = [];

  for (const path of files) {
    const lower = path.toLowerCase();
    for (const dir of TEMPLATE_DIRS) {
      if (!lower.startsWith(dir)) continue;
      const rest = lower.slice(dir.length);
      if (isDefaultTemplate(rest)) {
        defaults.push({ path, file: basename(path), note: dir || "repository root" });
      } else if (rest.startsWith(MULTI_DIR) && hasTemplateExtension(rest)) {
        multi.push({ path, file: basename(path), note: `${dir}PULL_REQUEST_TEMPLATE/` });
      }
      break;
    }
  }

  multi.sort((a, b) => a.path.localeCompare(b.path));
  return [...defaults, ...multi];
}

/**
 * A description seeded from the commit subjects the pull request carries.
 *
 * Newest-first is the order the range read returns; this reverses to reading
 * order, because a description is read top-down as "what happened, in
 * sequence". Duplicate subjects (an amended commit rebased twice, say) are kept
 * — dropping them would silently misreport the branch.
 */
export function bodyFromCommits(commits: HistorySearchResult[]): string {
  const lines = [...commits]
    .reverse()
    .map((commit) => `- ${commit.summary} (${commit.shortId})`)
    .join("\n");
  return `## Summary\n\n## Changes\n${lines}\n\n## Testing\n`;
}

function isDefaultTemplate(rest: string): boolean {
  return TEMPLATE_EXTENSIONS.some((extension) => rest === `${DEFAULT_STEM}${extension}`);
}

function hasTemplateExtension(rest: string): boolean {
  // The multi-template directory holds files, not the bare stem, so an
  // extensionless entry here is a subdirectory path rather than a template.
  return TEMPLATE_EXTENSIONS.filter(Boolean).some((extension) => rest.endsWith(extension));
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
