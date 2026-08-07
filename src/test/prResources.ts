// Test seeding for the pulls store's normalized per-PR resource record
// (GL-364): patch one resource's data/slots/errors without hand-building the
// whole record in every test. `seedThreads`/`seedCommits` accept the flat maps
// tests naturally write and fold them into the payload shapes.
import type { ReviewThread } from "@/lib/api";
import { usePulls } from "@/store/pulls";
import {
  patchPrResource,
  PR_RESOURCE,
  type PrCommitsMarker,
  type PrResourceKind,
  type PrResourceState,
} from "@/store/pullsResource";

export function seedPrResource<K extends PrResourceKind>(
  kind: K,
  patch: Partial<PrResourceState<K>>,
): void {
  usePulls.setState((s) => ({ prResources: patchPrResource(s.prResources, kind, patch) }));
}

/** Seed cached review threads (and optionally which PRs' walks truncated). */
export function seedThreads(
  byNum: Record<number, ReviewThread[]>,
  truncated: Record<number, boolean> = {},
): void {
  seedPrResource(PR_RESOURCE.Threads, {
    data: Object.fromEntries(
      Object.entries(byNum).map(([n, threads]) => [
        n,
        { threads, truncated: truncated[Number(n)] ?? false },
      ]),
    ),
  });
}

/** Seed the verified-commits markers from the flat loaded/truncated maps. */
export function seedCommits(
  loaded: Record<number, boolean>,
  truncated: Record<number, boolean> = {},
): void {
  const data: Record<number, PrCommitsMarker> = {};
  for (const n of Object.keys(loaded).map(Number)) {
    if (loaded[n]) data[n] = { truncated: truncated[n] ?? false };
  }
  for (const n of Object.keys(truncated).map(Number)) {
    data[n] ??= { truncated: truncated[n] };
  }
  seedPrResource(PR_RESOURCE.Commits, { data });
}
