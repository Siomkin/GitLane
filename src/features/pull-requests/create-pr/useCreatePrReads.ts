// Disposable reads the create-PR form needs and nothing else does: the commits
// and diffstat for the proposed range, which open pull request the branch was
// cut from, and the repository's pull-request templates.
//
// These are probes, not domain state — they live and die with one open dialog,
// key on the exact repo/base/head tuple, and are never cached across repos. So
// they stay here rather than growing four fields on the repo store, following
// the same boundary precedent as the menus' fast-forward and worktree-dirty
// probes (GL-156/GL-296). `api` is imported directly under that documented
// exemption (see eslint.config.js).

import { useEffect, useState } from "react";
import { api, type AncestorRef, type CompareResult, type HistorySearchResult } from "@/lib/api";
import { findPrTemplates, type PrTemplateRef } from "./prTemplates";

export interface RangeRead {
  commits: HistorySearchResult[];
  compare: CompareResult | null;
  loading: boolean;
}

const EMPTY_RANGE: RangeRead = { commits: [], compare: null, loading: false };

/**
 * Commits and file totals for `base..head`.
 *
 * Both reads are issued together and applied together, so the commit list and
 * the diffstat below it always describe the same range — a split update would
 * briefly show "6 commits" beside the previous base's file count.
 *
 * A failing read resolves to empty rather than surfacing an error: an
 * unfetched base is a normal state in this dialog, and the counts are
 * supporting detail, not something to block opening a pull request over.
 */
export function useRangeRead(repoPath: string | null, base: string, head: string): RangeRead {
  const [state, setState] = useState<RangeRead>(EMPTY_RANGE);

  useEffect(() => {
    if (!repoPath || !base || !head || base === head) {
      setState(EMPTY_RANGE);
      return;
    }
    let alive = true;
    setState((previous) => ({ ...previous, loading: true }));
    void Promise.all([
      api.rangeCommits(repoPath, base, head),
      api.compareRefs(repoPath, base, head),
    ])
      .then(([commits, compare]) => {
        if (alive) setState({ commits, compare, loading: false });
      })
      .catch(() => {
        if (alive) setState(EMPTY_RANGE);
      });
    return () => {
      alive = false;
    };
  }, [repoPath, base, head]);

  return state;
}

/**
 * Which of `candidates` the head branch descends from, nearest first.
 *
 * `candidates` is joined into the effect key rather than compared by identity —
 * the caller rebuilds the array every render from the pull request list, and
 * depending on the reference would re-probe on every keystroke in the title
 * field.
 */
export function useAncestorRefs(
  repoPath: string | null,
  head: string,
  candidates: string[],
  enabled: boolean,
): AncestorRef[] {
  const [ancestors, setAncestors] = useState<AncestorRef[]>([]);
  const key = candidates.join("\n");

  useEffect(() => {
    if (!repoPath || !head || !enabled || !key) {
      setAncestors([]);
      return;
    }
    let alive = true;
    void api
      .ancestorRefs(repoPath, head, key.split("\n"))
      .then((found) => {
        if (alive) setAncestors(found);
      })
      .catch(() => {
        if (alive) setAncestors([]);
      });
    return () => {
      alive = false;
    };
  }, [repoPath, head, key, enabled]);

  return ancestors;
}

/** Pull-request templates tracked in the repository. Empty when it has none. */
export function usePrTemplates(repoPath: string | null): PrTemplateRef[] {
  const [templates, setTemplates] = useState<PrTemplateRef[]>([]);

  useEffect(() => {
    if (!repoPath) {
      setTemplates([]);
      return;
    }
    let alive = true;
    void api
      .listRepoFiles(repoPath)
      .then((files) => {
        if (alive) setTemplates(findPrTemplates(files));
      })
      .catch(() => {
        if (alive) setTemplates([]);
      });
    return () => {
      alive = false;
    };
  }, [repoPath]);

  return templates;
}

/** One template's text, or null when it can't be read. */
export async function readTemplate(repoPath: string, path: string): Promise<string | null> {
  try {
    const file = await api.repoFileText(repoPath, path);
    // A binary or truncated read is not a template worth seeding a description
    // from — half a template is worse than none.
    return file.binary || file.truncated ? null : (file.text ?? null);
  } catch {
    return null;
  }
}
