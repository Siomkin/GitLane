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

import { useEffect, useState, type DependencyList } from "react";
import { api, type CompareResult, type HistorySearchResult } from "@/lib/api";
import { findPrTemplates, type PrTemplateRef } from "./prTemplates";

export interface RangeRead {
  commits: HistorySearchResult[];
  compare: CompareResult | null;
  loading: boolean;
}

const EMPTY_RANGE: RangeRead = { commits: [], compare: null, loading: false };

/**
 * One probe: run `load` when `enabled`, fall back to `fallback` otherwise or on
 * failure, and ignore an answer that arrives after the inputs changed.
 *
 * Every read here fails the same way on purpose — an unfetched base or a
 * repository without templates is a normal state in this dialog, and none of
 * these answers is worth blocking a pull request over.
 */
function useProbe<T>(
  load: () => Promise<T>,
  fallback: T,
  enabled: boolean,
  deps: DependencyList,
): T {
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => {
    if (!enabled) {
      setValue(fallback);
      return;
    }
    let alive = true;
    const settle = (next: T) => {
      if (alive) setValue(next);
    };
    void load().then(settle, () => settle(fallback));
    return () => {
      alive = false;
    };
    // `load` and `fallback` are re-created every render; the caller's `deps`
    // are the real identity of the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}

/**
 * Commits and file totals for `base..head`.
 *
 * Both reads are issued together and applied together, so the commit list and
 * the diffstat below it always describe the same range — a split update would
 * briefly show "6 commits" beside the previous base's file count.
 */
export function useRangeRead(repoPath: string | null, base: string, head: string): RangeRead {
  return useProbe(
    async () => {
      const [commits, compare] = await Promise.all([
        api.rangeCommits(repoPath!, base, head),
        api.compareRefs(repoPath!, base, head),
      ]);
      return { commits, compare, loading: false };
    },
    EMPTY_RANGE,
    !!repoPath && !!base && !!head && base !== head,
    [repoPath, base, head],
  );
}

/**
 * Which of `candidates` the head branch descends from, nearest first.
 *
 * `candidates` is joined into the dependency rather than passed by identity —
 * the caller rebuilds the array every render from the pull request list, and
 * depending on the reference would re-probe on every keystroke in the title.
 */
export function useAncestorRefs(
  repoPath: string | null,
  head: string,
  candidates: string[],
  enabled: boolean,
): string[] {
  const key = candidates.join("\n");
  return useProbe(
    () => api.ancestorRefs(repoPath!, head, key.split("\n")),
    [],
    !!repoPath && !!head && !!key && enabled,
    [repoPath, head, key, enabled],
  );
}

/**
 * The branch a new pull request should target, or null while unknown.
 *
 * Deliberately the repository's default branch rather than whatever `head` was
 * cut from: GitHub's rule is "the default branch in a repository is the base
 * branch for new pull requests", and with several branches in flight the
 * nearest ancestor is often somebody else's work. Stacking on the branch below
 * stays an explicit choice — which is also how GitHub's own UI behaves.
 */
export function useDefaultBase(repoPath: string | null, head: string): string | null {
  return useProbe(
    () => api.defaultBaseBranch(repoPath!, head),
    null as string | null,
    !!repoPath && !!head,
    [repoPath, head],
  );
}

/** Pull-request templates tracked in the repository. Empty when it has none. */
export function usePrTemplates(repoPath: string | null): PrTemplateRef[] {
  return useProbe(
    async () => findPrTemplates(await api.listRepoFiles(repoPath!)),
    [] as PrTemplateRef[],
    !!repoPath,
    [repoPath],
  );
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
