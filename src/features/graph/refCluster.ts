import { RefKind, type RefLabel } from "@/lib/api";

// Current branch first, then local branches / groups, remotes, and finally tags.
const REF_RANK: Record<RefLabel["kind"], number> = {
  [RefKind.Head]: 0,
  [RefKind.Branch]: 1,
  [RefKind.Remote]: 2,
  [RefKind.Tag]: 3,
};

/** One rendered slot in a commit's ref cluster: either a lone ref or a local
 * branch grouped with its in-sync remote-tracking ref(s) of the same name. */
export type ClusterItem =
  | { type: "single"; ref: RefLabel }
  | { type: "group"; base: string; local: RefLabel; remotes: RefLabel[] };

/** Strip the remote name from a remote-tracking ref so it can be matched against
 * a local branch: `origin/develop` → `develop`, `origin/feature/x` → `feature/x`. */
export function remoteBase(name: string): string {
  const slash = name.indexOf("/");
  return slash === -1 ? name : name.slice(slash + 1);
}

/** Group a commit's refs for display. A local branch and the remote-tracking
 * ref(s) of the same name collapse into one group — they're on this row, so by
 * definition they're in sync; the moment they diverge they move to different
 * rows and separate on their own. Everything else (local-only branches,
 * unmatched remotes, tags) passes through as a single. Ordered current-first,
 * then branches/groups, remotes, tags (`Array.sort` is stable, so insertion
 * order is preserved within a rank). */
export function buildClusterItems(
  refs: RefLabel[],
  currentBranch: string | null,
): ClusterItem[] {
  const visible = refs.filter((r) => r.kind !== RefKind.Head);
  const branches = visible.filter((r) => r.kind === RefKind.Branch);
  const remotes = visible.filter((r) => r.kind === RefKind.Remote);
  const others = visible.filter((r) => r.kind !== RefKind.Branch && r.kind !== RefKind.Remote);

  const remotesByBase = new Map<string, RefLabel[]>();
  for (const r of remotes) {
    const b = remoteBase(r.name);
    const list = remotesByBase.get(b);
    if (list) list.push(r);
    else remotesByBase.set(b, [r]);
  }

  const out: ClusterItem[] = [];
  const grouped = new Set<string>();
  for (const br of branches) {
    const matched = remotesByBase.get(br.name);
    if (matched && matched.length > 0) {
      out.push({ type: "group", base: br.name, local: br, remotes: matched });
      grouped.add(br.name);
    } else {
      out.push({ type: "single", ref: br });
    }
  }
  for (const [b, list] of remotesByBase) {
    if (grouped.has(b)) continue;
    for (const r of list) out.push({ type: "single", ref: r });
  }
  for (const r of others) out.push({ type: "single", ref: r });

  const rank = (it: ClusterItem) =>
    it.type === "group"
      ? it.base === currentBranch
        ? -1
        : REF_RANK.branch
      : it.ref.name === currentBranch
        ? -1
        : REF_RANK[it.ref.kind];
  return out.sort((a, b) => rank(a) - rank(b));
}
