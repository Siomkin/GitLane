// The resolver hook's selection transition and facade identity (GL-178).
// The selection contract: default to the first unresolved conflict, keep a
// still-valid manual selection across operation refreshes (the watcher re-reads
// the worktree constantly — a refresh must never clobber the user's place), and
// correct it only when the selected file actually leaves the set. The facade
// must be referentially stable across unrelated rerenders so consumers can list
// `resolver` honestly in hook dependencies.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useConflictResolver } from "./useConflictResolver";
import type { OperationState } from "@/store/repo";

const MARKERS = "start\n<<<<<<< HEAD\nour line\n=======\ntheir line\n>>>>>>> feat\nend\n";

function op(files: Array<{ path: string; resolved?: boolean }>): OperationState {
  return {
    kind: "merge",
    canSkip: false,
    files: files.map((f) => ({
      path: f.path,
      kind: "text" as const,
      deletedSide: "" as const,
      resolved: f.resolved ?? false,
    })),
  };
}

function renderResolver(operation: OperationState | null, repoPath: string | null = "/repo") {
  return renderHook(
    (props: { operation: OperationState | null; repoPath: string | null }) =>
      useConflictResolver(props.operation, props.repoPath),
    { initialProps: { operation, repoPath } },
  );
}

const flush = () => act(async () => {});

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
    cmd === "conflict_file"
      ? Promise.resolve({ path: args?.file, content: MARKERS, binary: false })
      : Promise.resolve(null),
  );
});

describe("useConflictResolver — staged result", () => {
  it("shows the worktree copy of a file that is already resolved", async () => {
    // `conflict_file` refuses a path that is no longer unmerged, so a staged
    // file used to render an empty editor. Read it from the worktree instead.
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "repo_file_text"
        ? Promise.resolve({ text: "merged result\n", size: 14, truncated: false, binary: false })
        : Promise.reject(new Error("not a conflicted path")),
    );
    const { result } = renderResolver(op([{ path: "a.txt", resolved: true }]));
    await flush();
    act(() => result.current.select("a.txt"));
    await flush();

    expect(result.current.content?.content).toBe("merged result\n");
    expect(result.current.contentLoading).toBe(false);
  });

  it("re-reads marker content after the file is unstaged", async () => {
    const { result, rerender } = renderResolver(op([{ path: "a.txt", resolved: true }]));
    await flush();
    act(() => result.current.select("a.txt"));
    await flush();

    rerender({ operation: op([{ path: "a.txt" }]), repoPath: "/repo" });
    await flush();
    expect(result.current.content?.content).toBe(MARKERS);
  });

  it("re-reads the worktree copy after the open file is staged", async () => {
    // Apply / Mark resolved stages the file but leaves the conflicted snapshot
    // in cache. The editor then paints those markers as the "staged result".
    const { result, rerender } = renderResolver(op([{ path: "a.txt" }]));
    await flush();
    expect(result.current.content?.content).toBe(MARKERS);

    invokeMock.mockImplementation((cmd: string) =>
      cmd === "repo_file_text"
        ? Promise.resolve({ text: "merged result\n", size: 14, truncated: false, binary: false })
        : Promise.reject(new Error("not a conflicted path")),
    );
    rerender({ operation: op([{ path: "a.txt", resolved: true }]), repoPath: "/repo" });
    await flush();

    expect(result.current.content?.content).toBe("merged result\n");
  });
});

describe("useConflictResolver — selection transition (GL-178)", () => {
  it("defaults the selection to the first unresolved file", async () => {
    const { result } = renderResolver(op([{ path: "a.txt", resolved: true }, { path: "b.txt" }]));
    await flush();
    expect(result.current.selected).toBe("b.txt");
  });

  it("keeps a valid manual selection across an operation refresh with new identities", async () => {
    const { result, rerender } = renderResolver(op([{ path: "a.txt" }, { path: "b.txt" }]));
    await flush();
    act(() => result.current.select("b.txt"));
    await flush();

    // The watcher re-read the worktree: a fresh OperationState object with a
    // fresh files array but identical content. The user's place must survive.
    rerender({ operation: op([{ path: "a.txt" }, { path: "b.txt" }]), repoPath: "/repo" });
    await flush();
    expect(result.current.selected).toBe("b.txt");
  });

  it("moves the selection to the first unresolved file when the selected one leaves the set", async () => {
    const { result, rerender } = renderResolver(op([{ path: "a.txt" }, { path: "b.txt" }]));
    await flush();
    act(() => result.current.select("b.txt"));
    await flush();

    rerender({ operation: op([{ path: "a.txt" }]), repoPath: "/repo" });
    await flush();
    expect(result.current.selected).toBe("a.txt");
  });

  it("caches the selected text file's conflicted content and exposes it via contentFor", async () => {
    const { result } = renderResolver(op([{ path: "a.txt" }]));
    await flush();

    expect(result.current.content?.content).toBe(MARKERS);
    expect(result.current.contentFor("a.txt")?.content).toBe(MARKERS);
    expect(invokeMock.mock.calls.filter((c) => c[0] === "conflict_file")).toHaveLength(1);
  });
});

describe("useConflictResolver — worktree revalidation (GL-179)", () => {
  it("background-revalidates the open file's cached content on an operation refresh", async () => {
    const { result, rerender } = renderResolver(op([{ path: "a.txt" }]));
    await flush();
    expect(result.current.content?.content).toBe(MARKERS);

    // The file changed on disk (external editor); the watcher re-read the
    // worktree, producing a fresh operation object with identical metadata.
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === "conflict_file"
        ? Promise.resolve({ path: args?.file, content: "fresh from disk", binary: false })
        : Promise.resolve(null),
    );
    rerender({ operation: op([{ path: "a.txt" }]), repoPath: "/repo" });
    await flush();

    expect(result.current.content?.content).toBe("fresh from disk");
  });

  it("drops other unresolved files' cached content on a refresh so re-select re-fetches", async () => {
    const { result, rerender } = renderResolver(op([{ path: "a.txt" }, { path: "b.txt" }]));
    await flush();
    act(() => result.current.select("b.txt"));
    await flush();
    act(() => result.current.select("a.txt"));
    await flush();
    expect(result.current.contentFor("b.txt")).toBeDefined();

    rerender({ operation: op([{ path: "a.txt" }, { path: "b.txt" }]), repoPath: "/repo" });
    await flush();

    // The non-open unresolved file's cache is evicted (it re-fetches on next
    // select); the open file keeps content visible while revalidating.
    expect(result.current.contentFor("b.txt")).toBeUndefined();
    expect(result.current.contentFor("a.txt")).toBeDefined();
  });

  it("does not refetch cached content when only the selection changes", async () => {
    const { result } = renderResolver(op([{ path: "a.txt" }, { path: "b.txt" }]));
    await flush();
    act(() => result.current.select("b.txt"));
    await flush();
    const fetches = () => invokeMock.mock.calls.filter((c) => c[0] === "conflict_file").length;
    const before = fetches();

    // Selecting back a cached file must not re-run the revalidation effect —
    // it is keyed by the operation object, not by selection.
    act(() => result.current.select("a.txt"));
    await flush();
    expect(fetches()).toBe(before);
  });
});

describe("useConflictResolver — path-key robustness (GL-178 review)", () => {
  it("keeps a selection whose filename contains a newline across a refresh", async () => {
    const weird = "we\nird.txt";
    const { result, rerender } = renderResolver(op([{ path: weird }, { path: "b.txt" }]));
    await flush();
    expect(result.current.selected).toBe(weird);

    rerender({ operation: op([{ path: weird }, { path: "b.txt" }]), repoPath: "/repo" });
    await flush();
    // A delimiter-based path key would misparse the newline and clobber this.
    expect(result.current.selected).toBe(weird);
  });

  it("resetFile drops only the exact file's cells, not a ::-prefixed sibling's", async () => {
    const { result } = renderResolver(op([{ path: "a.txt" }, { path: "a.txt::gen" }]));
    await flush();
    act(() => {
      result.current.decide("a.txt", 0, "ours");
      result.current.decide("a.txt::gen", 0, "theirs");
    });

    act(() => result.current.resetFile("a.txt"));

    expect(result.current.decisions["a.txt::0"]).toBeUndefined();
    // The sibling's decision must survive — never discard user choices.
    expect(result.current.decisions["a.txt::gen::0"]).toBe("theirs");
  });
});

// Two hunks so one can change on disk while the other stays intact: regions are
// [ctx, cf@1, ctx, cf@3, ctx].
const TWO_HUNKS =
  "a\n<<<<<<< HEAD\none ours\n=======\none theirs\n>>>>>>> feat\nmid\n<<<<<<< HEAD\ntwo ours\n=======\ntwo theirs\n>>>>>>> feat\nz\n";
const TWO_HUNKS_FIRST_EDITED = TWO_HUNKS.replace("one ours", "one ours edited");

const serveConflictFile = (content: string) => {
  invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
    cmd === "conflict_file"
      ? Promise.resolve({ path: args?.file, content, binary: false })
      : Promise.resolve(null),
  );
};

describe("useConflictResolver — stale-decision invalidation (GL-180)", () => {
  it("invalidates only the changed hunk's decision when revalidation returns new content", async () => {
    serveConflictFile(TWO_HUNKS);
    const { result, rerender } = renderResolver(op([{ path: "a.txt" }]));
    await flush();
    act(() => {
      result.current.decide("a.txt", 1, "ours");
      result.current.decide("a.txt", 3, "theirs");
    });

    // The first hunk changed on disk (external editor); the watcher re-read the
    // worktree and the open file background-revalidates.
    serveConflictFile(TWO_HUNKS_FIRST_EDITED);
    rerender({ operation: op([{ path: "a.txt" }]), repoPath: "/repo" });
    await flush();

    // The changed hunk's decision would now apply to different lines — gone.
    expect(result.current.decisions["a.txt::1"]).toBeUndefined();
    // The untouched hunk's decision must survive — never discard user choices
    // for content that didn't change.
    expect(result.current.decisions["a.txt::3"]).toBe("theirs");
  });

  it("keeps every decision when revalidation returns identical content", async () => {
    serveConflictFile(TWO_HUNKS);
    const { result, rerender } = renderResolver(op([{ path: "a.txt" }]));
    await flush();
    act(() => {
      result.current.decide("a.txt", 1, "ours");
      result.current.setLineSelection("a.txt", 3, new Set(["b:0"]));
    });

    // A plain watcher refresh: fresh operation object, unchanged file content.
    rerender({ operation: op([{ path: "a.txt" }]), repoPath: "/repo" });
    await flush();

    expect(result.current.decisions["a.txt::1"]).toBe("ours");
    expect(result.current.lineSel["a.txt::3"]).toEqual(new Set(["b:0"]));
  });

  it("drops line picks bound to a changed hunk", async () => {
    serveConflictFile(TWO_HUNKS);
    const { result, rerender } = renderResolver(op([{ path: "a.txt" }]));
    await flush();
    act(() => result.current.setLineSelection("a.txt", 1, new Set(["a:0", "b:0"])));

    serveConflictFile(TWO_HUNKS_FIRST_EDITED);
    rerender({ operation: op([{ path: "a.txt" }]), repoPath: "/repo" });
    await flush();

    // Stale picks reference lines that may no longer exist in the new hunk.
    expect(result.current.lineSel["a.txt::1"]).toBeUndefined();
  });

  it("conservatively drops decisions when a structural edit shifts hunk indices", async () => {
    // Documents the intended trade-off: decisions are bound to (region index,
    // fingerprint), so inserting a hunk above a decided one shifts indices and
    // invalidates the shifted decisions even though their hunk text moved
    // unchanged. Safe (never stages the wrong hunk) at the cost of re-deciding.
    serveConflictFile(TWO_HUNKS);
    const { result, rerender } = renderResolver(op([{ path: "a.txt" }]));
    await flush();
    act(() => {
      result.current.decide("a.txt", 1, "ours");
      result.current.decide("a.txt", 3, "theirs");
    });

    serveConflictFile(
      `<<<<<<< HEAD\nzero ours\n=======\nzero theirs\n>>>>>>> feat\n${TWO_HUNKS}`,
    );
    rerender({ operation: op([{ path: "a.txt" }]), repoPath: "/repo" });
    await flush();

    expect(result.current.decisions["a.txt::1"]).toBeUndefined();
    expect(result.current.decisions["a.txt::3"]).toBeUndefined();
  });

  it("prunes stale decisions when an evicted file re-fetches changed content", async () => {
    serveConflictFile(TWO_HUNKS);
    const { result, rerender } = renderResolver(op([{ path: "a.txt" }, { path: "b.txt" }]));
    await flush();
    act(() => result.current.decide("a.txt", 1, "ours"));

    // Open b.txt, then a refresh evicts a.txt's cache (it isn't the open file).
    act(() => result.current.select("b.txt"));
    await flush();
    serveConflictFile(TWO_HUNKS_FIRST_EDITED);
    rerender({ operation: op([{ path: "a.txt" }, { path: "b.txt" }]), repoPath: "/repo" });
    await flush();

    // Re-selecting a.txt re-fetches the (changed) disk copy — the decision made
    // against the old hunk must not map onto the new one.
    act(() => result.current.select("a.txt"));
    await flush();
    expect(result.current.decisions["a.txt::1"]).toBeUndefined();
  });

  it("an older in-flight fetch cannot clobber content a newer revalidate() applied", async () => {
    serveConflictFile(TWO_HUNKS);
    const { result, rerender } = renderResolver(op([{ path: "a.txt" }]));
    await flush();
    act(() => result.current.decide("a.txt", 3, "theirs"));

    // The watcher-refresh background revalidation hangs (slow disk read that
    // still sees the OLD content)…
    let releaseOld!: (content: unknown) => void;
    invokeMock.mockImplementationOnce(
      () => new Promise((resolve) => (releaseOld = resolve)),
    );
    rerender({ operation: op([{ path: "a.txt" }]), repoPath: "/repo" });
    await flush();

    // …while a stage-time revalidate() reads the newer disk state and applies it.
    serveConflictFile(TWO_HUNKS_FIRST_EDITED);
    await act(async () => {
      await result.current.revalidate("a.txt");
    });
    expect(result.current.contentFor("a.txt")?.content).toBe(TWO_HUNKS_FIRST_EDITED);

    // The slow old response lands last — it must be discarded, not applied: it
    // would revert the cache and prune decisions against an obsolete snapshot.
    await act(async () => {
      releaseOld({ path: "a.txt", content: TWO_HUNKS, binary: false });
    });
    expect(result.current.contentFor("a.txt")?.content).toBe(TWO_HUNKS_FIRST_EDITED);
    expect(result.current.decisions["a.txt::3"]).toBe("theirs");
  });

  it("revalidate() returns the fresh content, refreshes the cache, and prunes", async () => {
    serveConflictFile(TWO_HUNKS);
    const { result } = renderResolver(op([{ path: "a.txt" }]));
    await flush();
    act(() => {
      result.current.decide("a.txt", 1, "ours");
      result.current.decide("a.txt", 3, "theirs");
    });

    serveConflictFile(TWO_HUNKS_FIRST_EDITED);
    const fresh: Array<Awaited<ReturnType<typeof result.current.revalidate>>> = [];
    await act(async () => {
      fresh.push(await result.current.revalidate("a.txt"));
    });

    expect(fresh[0]?.content).toBe(TWO_HUNKS_FIRST_EDITED);
    expect(result.current.contentFor("a.txt")?.content).toBe(TWO_HUNKS_FIRST_EDITED);
    expect(result.current.decisions["a.txt::1"]).toBeUndefined();
    expect(result.current.decisions["a.txt::3"]).toBe("theirs");
  });
});

describe("useConflictResolver — facade identity (GL-178)", () => {
  it("produces a new facade when the selected file's content loads", async () => {
    const { result } = renderResolver(op([{ path: "a.txt" }]));
    const before = result.current; // fetch still pending — content null

    await flush();

    expect(result.current).not.toBe(before);
    expect(result.current.content?.content).toBe(MARKERS);
  });

  it("returns a referentially stable facade across unrelated rerenders", async () => {
    // A resolved-only set fetches nothing, so nothing internal changes between
    // renders — the facade must not be rebuilt per render.
    const operation = op([{ path: "a.txt", resolved: true }]);
    const { result, rerender } = renderResolver(operation);
    await flush();

    const before = result.current;
    rerender({ operation, repoPath: "/repo" });
    await flush();
    expect(result.current).toBe(before);
  });

  it("a line selection supersedes a prior whole-hunk decision (and vice versa)", async () => {
    const { result } = renderResolver(op([{ path: "a.txt" }]));
    await flush();

    act(() => result.current.decide("a.txt", 0, "ours"));
    act(() => result.current.setLineSelection("a.txt", 0, new Set(["b:0"])));
    // The picks own the hunk now — the stale whole-hunk decision is cleared.
    expect(result.current.decisions["a.txt::0"]).toBeUndefined();
    expect(result.current.lineSel["a.txt::0"]).toEqual(new Set(["b:0"]));

    act(() => result.current.decide("a.txt", 0, "theirs"));
    expect(result.current.lineSel["a.txt::0"]).toBeUndefined();
    expect(result.current.decisions["a.txt::0"]).toBe("theirs");
    expect(result.current.customText["a.txt::0"]).toBeUndefined();
  });

  it("a whole-hunk decision drops a prior custom rewrite", async () => {
    const { result } = renderResolver(op([{ path: "a.txt" }]));
    await flush();

    act(() => result.current.setCustomResolution("a.txt", 0, ["merged"]));
    expect(result.current.customText["a.txt::0"]).toEqual(["merged"]);
    act(() => result.current.decide("a.txt", 0, "ours"));
    expect(result.current.customText["a.txt::0"]).toBeUndefined();
    expect(result.current.decisions["a.txt::0"]).toBe("ours");
  });

  it("produces a new facade when a decision lands (not over-memoized)", async () => {
    const { result } = renderResolver(op([{ path: "a.txt" }]));
    await flush();

    const before = result.current;
    act(() => result.current.decide("a.txt", 0, "ours"));
    expect(result.current).not.toBe(before);
    expect(result.current.decisions["a.txt::0"]).toBe("ours");
  });
});
